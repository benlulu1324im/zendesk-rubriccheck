import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import {
  PLAN_CATALOG,
  RUBRIC_TEMPLATES,
  RubricInputSchema,
} from '@rubriccheck/shared';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import type { Repository, TenantRecord } from './db/repository.js';
import { EvaluationOrchestrator, QuotaExceededError } from './services/evaluationOrchestrator.js';
import { GeminiDecisionEngine, type InMemoryAttachment } from './services/geminiDecision.js';
import { PaddleBillingService } from './services/paddleBilling.js';
import { ZafAuthService } from './services/zafAuth.js';
import { ZendeskClient } from './services/zendeskClient.js';
import {
  decryptSecret,
  encryptSecret,
  signHs256Jwt,
  verifyHs256Jwt,
  verifyZendeskWebhookSignature,
} from './utils/crypto.js';

export interface SessionClaims extends Record<string, unknown> {
  tenantId: string;
  subdomain: string;
  userId: string;
  userName: string;
}

export interface AppDependencies {
  config: AppConfig;
  repo: Repository;
  gemini?: GeminiDecisionEngine;
  zendesk?: ZendeskClient;
  zafAuth?: ZafAuthService;
  billing?: PaddleBillingService;
}

const SimulateRequestSchema = z.object({
  ticketId: z.string().min(1).max(32),
  subject: z.string().min(1).max(160),
  assigneeName: z.string().min(1).max(80).default('Maya Cohen'),
  transcriptText: z.string().min(5).max(50_000),
  rubricId: z.string().optional(),
  attachments: z
    .array(
      z.object({
        attachmentId: z.string().min(1),
        commentId: z.string().default('1001'),
        filename: z.string().min(1),
        mimeType: z.string().default('image/png'),
        base64Data: z.string().optional(),
      }),
    )
    .default([]),
});

export function createApp(deps: AppDependencies) {
  const { config, repo } = deps;
  const gemini = deps.gemini ?? new GeminiDecisionEngine(config);
  const zendesk = deps.zendesk ?? new ZendeskClient(config, repo);
  const zafAuth = deps.zafAuth ?? new ZafAuthService(config);
  const billing = deps.billing ?? new PaddleBillingService(config, repo);
  const orchestrator = new EvaluationOrchestrator(repo, gemini, zendesk);

  const app = new Hono();

  app.use(
    '/api/*',
    cors({
      origin: (origin) => origin || '*',
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  );

  // Healthcheck (Cloud Run readiness/liveness)
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'rubriccheck-qa',
      model: config.geminiDecisionModel,
      paddleEnv: config.paddleEnv,
      dbDriver: config.dbDriver,
      timestamp: new Date().toISOString(),
    }),
  );

  // Helper: extract authenticated session from Bearer token
  async function requireSession(
    c: Context,
  ): Promise<{ claims: SessionClaims; tenant: TenantRecord } | null> {
    const authHeader = c.req.header('authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) return null;
    try {
      const claims = verifyHs256Jwt<SessionClaims>(token, config.sessionSecret);
      const tenant = await repo.getTenantById(claims.tenantId);
      if (!tenant) return null;
      return { claims, tenant };
    } catch {
      return null;
    }
  }

  // ZAF signedUrls entrypoints (POST with RS256 signed JWT in form body `token`)
  async function handleZafSignedEntry(c: Context, view: 'sidebar' | 'dashboard') {
    const body = await c.req.parseBody();
    const token = typeof body['token'] === 'string' ? body['token'] : '';
    if (!token) {
      return c.text('Missing Zendesk signedUrls JWT token', 400);
    }
    try {
      const verified = await zafAuth.verifySignedUrlJwt(token);
      const tenant = await repo.getOrCreateTenant(verified.subdomain);
      const sessionToken = signHs256Jwt<SessionClaims>(
        {
          tenantId: tenant.id,
          subdomain: tenant.zendeskSubdomain,
          userId: verified.userId,
          userName: verified.name,
        },
        config.sessionSecret,
        60 * 60 * 4,
      );
      const targetUrl = `${config.frontendUrl}/?view=${view}#session=${encodeURIComponent(sessionToken)}`;
      return c.redirect(targetUrl, 302);
    } catch (err) {
      return c.text(`Unauthorized ZAF request: ${(err as Error).message}`, 401);
    }
  }

  app.post('/zaf/sidebar', (c) => handleZafSignedEntry(c, 'sidebar'));
  app.post('/zaf/dashboard', (c) => handleZafSignedEntry(c, 'dashboard'));

  // Dev/Preview session bootstrap (strictly disabled in production unless ZENDESK_DEV_MODE=true)
  app.post('/api/session/dev', async (c) => {
    if (!config.zendeskDevMode) {
      return c.json({ error: 'Dev session endpoint disabled in production' }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      subdomain?: string;
      userName?: string;
    };
    const subdomain = (body.subdomain || 'acme-support').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const tenant = await repo.getOrCreateTenant(subdomain);
    const token = signHs256Jwt<SessionClaims>(
      {
        tenantId: tenant.id,
        subdomain: tenant.zendeskSubdomain,
        userId: 'dev_admin_1',
        userName: body.userName || 'Dana Levi (QA Lead)',
      },
      config.sessionSecret,
      60 * 60 * 12,
    );
    return c.json({ token, subdomain: tenant.zendeskSubdomain, planTier: tenant.planTier });
  });

  // Zendesk Global OAuth 2.0 Flow
  app.get('/oauth/zendesk/start', async (c) => {
    const subdomain = (c.req.query('subdomain') ?? '').trim().toLowerCase();
    if (!subdomain || !/^[a-z0-9-]+$/.test(subdomain)) {
      return c.json({ error: 'Valid Zendesk subdomain is required' }, 400);
    }
    const state = signHs256Jwt({ subdomain, purpose: 'zendesk_oauth' }, config.sessionSecret, 600);
    const authorizeUrl = zendesk.buildAuthorizeUrl(subdomain, state);
    return c.redirect(authorizeUrl, 302);
  });

  app.get('/oauth/zendesk/callback', async (c) => {
    const code = c.req.query('code') ?? '';
    const state = c.req.query('state') ?? '';
    const oauthErr = c.req.query('error');
    if (oauthErr) {
      return c.text(`Zendesk OAuth authorization declined: ${oauthErr}`, 400);
    }
    if (!code || !state) {
      return c.text('Missing code or state parameter', 400);
    }

    try {
      const verifiedState = verifyHs256Jwt<{ subdomain: string; purpose: string }>(
        state,
        config.sessionSecret,
      );
      if (verifiedState.purpose !== 'zendesk_oauth') {
        throw new Error('Invalid OAuth state purpose');
      }
      const tenant = await repo.getOrCreateTenant(verifiedState.subdomain);
      const tokens = await zendesk.exchangeCodeForTokens(verifiedState.subdomain, code);
      const expiresAt = new Date(Date.now() + tokens.expiresInSec * 1000).toISOString();

      await repo.updateTenantOAuth(tenant.id, {
        accessTokenEnc: encryptSecret(tokens.accessToken, config.encryptionKey),
        refreshTokenEnc: tokens.refreshToken
          ? encryptSecret(tokens.refreshToken, config.encryptionKey)
          : null,
        expiresAt,
      });

      const refreshedTenant = (await repo.getTenantById(tenant.id))!;
      let webhookNote = 'connected';
      try {
        await zendesk.provisionEventWebhook(refreshedTenant);
      } catch (whErr) {
        webhookNote = `connected_webhook_pending: ${(whErr as Error).message}`;
      }

      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;padding:32px;max-width:480px;margin:auto">
          <h2>RubricCheck QA Connected</h2>
          <p>Subdomain <strong>${verifiedState.subdomain}.zendesk.com</strong> authorized (${webhookNote}).</p>
          <p>You can close this window and return to Zendesk.</p>
          <script>if (window.opener) { window.opener.postMessage({ type: 'rubriccheck_oauth_done' }, '*'); }</script>
        </body></html>`,
      );
    } catch (err) {
      return c.text(`OAuth callback failed: ${(err as Error).message}`, 400);
    }
  });

  // Dashboard & Overview API
  app.get('/api/dashboard/overview', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const overview = await repo.getDashboardOverview(auth.tenant.id);
    return c.json(overview);
  });

  app.get('/api/dashboard/export.csv', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    if (!PLAN_CATALOG[auth.tenant.planTier].csvExport) {
      return c.json({ error: 'CSV export requires Growth or Scale plan' }, 403);
    }
    const rows = await repo.listEvaluations(auth.tenant.id, 500);
    const header = [
      'evaluated_at',
      'ticket_id',
      'assignee',
      'rubric',
      'score',
      'passed',
      'pii_detected',
      'pii_severity',
      'coaching_priority',
      'latency_ms',
    ].join(',');
    const csvLines = rows.map((r) =>
      [
        r.evaluatedAt,
        r.ticketId,
        `"${r.assigneeName.replace(/"/g, '""')}"`,
        `"${r.rubricName.replace(/"/g, '""')}"`,
        r.overallScore,
        r.passed ? 'PASS' : 'REVIEW',
        r.piiDetected ? 'YES' : 'NO',
        r.piiSeverity,
        r.coachingPriority,
        r.latencyMs,
      ].join(','),
    );
    return new Response([header, ...csvLines].join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rubriccheck-${auth.tenant.zendeskSubdomain}.csv"`,
      },
    });
  });

  // Rubrics CRUD
  app.get('/api/rubrics/templates', (c) => c.json({ templates: RUBRIC_TEMPLATES }));

  app.get('/api/rubrics', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const rubrics = await repo.listRubrics(auth.tenant.id);
    return c.json({ rubrics, limits: PLAN_CATALOG[auth.tenant.planTier] });
  });

  app.post('/api/rubrics', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const existing = await repo.listRubrics(auth.tenant.id);
    const limits = PLAN_CATALOG[auth.tenant.planTier];
    if (existing.length >= limits.maxRubrics) {
      return c.json(
        { error: `Your ${limits.name} plan allows up to ${limits.maxRubrics} rubric(s). Upgrade to add more.` },
        403,
      );
    }
    const parsed = RubricInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid rubric payload', details: parsed.error.flatten() }, 400);
    }
    if (parsed.data.criteria.length > limits.maxCriteriaPerRubric) {
      return c.json(
        {
          error: `Your ${limits.name} plan allows up to ${limits.maxCriteriaPerRubric} criteria per rubric.`,
        },
        403,
      );
    }
    const created = await repo.createRubric(auth.tenant.id, parsed.data);
    return c.json({ rubric: created }, 201);
  });

  app.put('/api/rubrics/:id', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const parsed = RubricInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid rubric payload', details: parsed.error.flatten() }, 400);
    }
    const limits = PLAN_CATALOG[auth.tenant.planTier];
    if (parsed.data.criteria.length > limits.maxCriteriaPerRubric) {
      return c.json(
        { error: `Maximum ${limits.maxCriteriaPerRubric} criteria allowed on ${limits.name} plan.` },
        403,
      );
    }
    const updated = await repo.updateRubric(auth.tenant.id, c.req.param('id'), parsed.data);
    if (!updated) return c.json({ error: 'Rubric not found' }, 404);
    return c.json({ rubric: updated });
  });

  app.delete('/api/rubrics/:id', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const ok = await repo.deleteRubric(auth.tenant.id, c.req.param('id'));
    if (!ok) return c.json({ error: 'Cannot delete the only active rubric' }, 400);
    return c.json({ deleted: true });
  });

  // Ticket Evaluation & One-Click PII Redaction APIs
  app.get('/api/tickets/:ticketId/evaluation', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const ticketId = c.req.param('ticketId');
    const [evaluation, piiFindings] = await Promise.all([
      repo.getLatestEvaluationForTicket(auth.tenant.id, ticketId),
      repo.listPiiFindingsForTicket(auth.tenant.id, ticketId),
    ]);
    return c.json({
      evaluation,
      piiFindings,
      quota: {
        used: auth.tenant.monthlyTicketCount,
        limit: PLAN_CATALOG[auth.tenant.planTier].monthlyTicketLimit,
        planTier: auth.tenant.planTier,
      },
    });
  });

  app.post('/api/tickets/:ticketId/evaluate', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const ticketId = c.req.param('ticketId');
    const body = (await c.req.json().catch(() => ({}))) as { rubricId?: string };

    try {
      if (auth.tenant.oauthConnected) {
        const outcome = await orchestrator.evaluateLiveZendeskTicket(
          auth.tenant,
          ticketId,
          body.rubricId,
        );
        return c.json(outcome);
      }
      return c.json(
        {
          error:
            'Zendesk Global OAuth is not connected yet. Connect Zendesk in Settings or use Simulate Scan in dev mode.',
        },
        409,
      );
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return c.json({ error: err.message, code: 'QUOTA_EXCEEDED' }, 402);
      }
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Sandbox / Demo Multimodal Evaluation Endpoint (accepts synthetic ticket + base64 image/PDF in RAM)
  app.post('/api/tickets/simulate', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const parsed = SimulateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid simulation payload', details: parsed.error.flatten() }, 400);
    }

    const attachments: InMemoryAttachment[] = parsed.data.attachments.map((a) => ({
      attachmentId: a.attachmentId,
      commentId: a.commentId,
      filename: a.filename,
      contentUrl: `https://${auth.tenant.zendeskSubdomain}.zendesk.com/attachments/token/sim/?name=${encodeURIComponent(a.filename)}`,
      mimeType: a.mimeType,
      bytes: a.base64Data ? Buffer.from(a.base64Data, 'base64') : Buffer.from('simulated-media'),
    }));

    try {
      const outcome = await orchestrator.evaluateBundle(auth.tenant, {
        ticketId: parsed.data.ticketId,
        subject: parsed.data.subject,
        assigneeName: parsed.data.assigneeName,
        transcriptText: parsed.data.transcriptText,
        attachments,
        rubricId: parsed.data.rubricId,
        writeBackToZendesk: false,
      });
      return c.json(outcome);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        return c.json({ error: err.message, code: 'QUOTA_EXCEEDED' }, 402);
      }
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // One-click PII Attachment Redaction
  app.post('/api/pii/:findingId/redact', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const finding = await repo.getPiiFindingById(auth.tenant.id, c.req.param('findingId'));
    if (!finding) return c.json({ error: 'PII finding not found' }, 404);
    if (finding.status === 'redacted') {
      return c.json({ finding, alreadyRedacted: true });
    }

    if (auth.tenant.oauthConnected && finding.attachmentUrl && finding.commentId !== '0') {
      try {
        await zendesk.redactAttachment(
          auth.tenant,
          finding.ticketId,
          finding.commentId,
          finding.attachmentUrl,
        );
        const defRubric = await repo.getDefaultRubric(auth.tenant.id);
        await zendesk.applyTicketTagsAndNote(auth.tenant, finding.ticketId, {
          additionalTags: [defRubric.autoTagConfig.redactedTag],
          internalNote: `[RubricCheck PII Guardrail] Attachment "${finding.attachmentFilename}" was permanently redacted by ${auth.claims.userName}.`,
        });
      } catch (err) {
        return c.json({ error: `Zendesk redaction failed: ${(err as Error).message}` }, 502);
      }
    }

    const updated = await repo.markPiiFindingStatus(
      auth.tenant.id,
      finding.id,
      'redacted',
      auth.claims.userName,
    );
    return c.json({ finding: updated });
  });

  app.post('/api/pii/:findingId/dismiss', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    const updated = await repo.markPiiFindingStatus(
      auth.tenant.id,
      c.req.param('findingId'),
      'dismissed',
      auth.claims.userName,
    );
    if (!updated) return c.json({ error: 'PII finding not found' }, 404);
    return c.json({ finding: updated });
  });

  // Billing Config & Paddle Customer Portal
  app.get('/api/billing/config', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(billing.getClientCheckoutConfig(auth.tenant));
  });

  app.post('/api/billing/portal', async (c) => {
    const auth = await requireSession(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    try {
      const url = await billing.createCustomerPortalUrl(auth.tenant);
      return c.json({ url });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Deduplicate rapid Zendesk event bursts per (tenantId:ticketId) and guard against self-note loops
  const recentTicketScans = new Map<string, { at: number; attachmentCount: number }>();
  const inflightTicketScans = new Map<string, Promise<{ attachmentCount: number } | null>>();

  // Zendesk Event Webhook Receiver (verifies HMAC-SHA256 signature & evaluates within Cloud Run request lifecycle)
  app.post('/webhooks/zendesk', async (c) => {
    const rawBody = await c.req.text();
    const subdomain = (c.req.query('subdomain') ?? '').trim().toLowerCase();
    if (!subdomain) return c.json({ error: 'Missing subdomain query param' }, 400);

    const tenant = await repo.getTenantBySubdomain(subdomain);
    if (!tenant) return c.json({ error: 'Unknown tenant' }, 404);

    if (tenant.webhookSecretEnc) {
      const secret = decryptSecret(tenant.webhookSecretEnc, config.encryptionKey);
      const valid = verifyZendeskWebhookSignature({
        signature: c.req.header('x-zendesk-webhook-signature'),
        timestamp: c.req.header('x-zendesk-webhook-signature-timestamp'),
        rawBody,
        signingSecret: secret,
      });
      if (!valid) {
        return c.json({ error: 'Invalid Zendesk webhook signature' }, 401);
      }
    }

    const payload = JSON.parse(rawBody) as {
      type?: string;
      subject?: string;
      detail?: {
        id?: string | number;
        ticket_id?: string | number;
        status?: string;
        comment?: { body?: string; is_public?: boolean; public?: boolean };
      };
      event?: {
        attachment_id?: string | number;
        current?: string;
        comment?: { body?: string; is_public?: boolean; public?: boolean };
      };
    };

    const subjectTicketId = payload.subject?.startsWith('zen:ticket:')
      ? payload.subject.slice('zen:ticket:'.length)
      : null;
    const ticketId = payload.detail?.id
      ? String(payload.detail.id)
      : payload.detail?.ticket_id
        ? String(payload.detail.ticket_id)
        : subjectTicketId;
    if (!ticketId) return c.json({ ok: true, ignored: true });

    // Never loop on RubricCheck's own internal PII warning / redaction audit notes
    const commentBody = payload.event?.comment?.body ?? payload.detail?.comment?.body ?? '';
    if (
      payload.type === 'zen:event-type:ticket.comment_added' &&
      commentBody.includes('[RubricCheck PII Guardrail]')
    ) {
      return c.json({ ok: true, ignored: true, reason: 'self_note' });
    }

    if (payload.type === 'zen:event-type:ticket.attachment_redacted_from_comment') {
      const attId = payload.event?.attachment_id ? String(payload.event.attachment_id) : null;
      if (attId) {
        await repo.markPiiFindingRedactedByAttachment(tenant.id, ticketId, attId, 'Zendesk Native');
      }
      return c.json({ ok: true, syncedRedaction: true });
    }

    const isAttachmentEvent = payload.type === 'zen:event-type:ticket.attachment_linked_to_comment';
    const shouldEvaluate =
      isAttachmentEvent ||
      payload.type === 'zen:event-type:ticket.comment_added' ||
      (payload.type === 'zen:event-type:ticket.status_changed' &&
        (payload.event?.current === 'solved' ||
          payload.event?.current === 'closed' ||
          payload.detail?.status === 'solved' ||
          payload.detail?.status === 'closed'));

    if (shouldEvaluate && tenant.oauthConnected) {
      const scanKey = `${tenant.id}:${ticketId}`;
      const existingInflight = inflightTicketScans.get(scanKey);
      if (existingInflight && !isAttachmentEvent) {
        return c.json({ ok: true, deduplicated: true });
      }
      const recent = recentTicketScans.get(scanKey);
      if (recent && Date.now() - recent.at < 8_000) {
        // Allow attachment_linked_to_comment through if the earlier comment_added scan saw 0 attachments
        if (!isAttachmentEvent || recent.attachmentCount > 0) {
          return c.json({ ok: true, deduplicated: true });
        }
      }

      const evalPromise = orchestrator
        .evaluateLiveZendeskTicket(tenant, ticketId)
        .then((outcome) => {
          recentTicketScans.set(scanKey, {
            at: Date.now(),
            attachmentCount: outcome.evaluation.attachmentCount,
          });
          return { attachmentCount: outcome.evaluation.attachmentCount };
        })
        .catch((err) => {
          console.error(`[webhook] Evaluation failed for ${subdomain}#${ticketId}:`, err);
          return null;
        })
        .finally(() => {
          if (inflightTicketScans.get(scanKey) === evalPromise) {
            inflightTicketScans.delete(scanKey);
          }
        });
      inflightTicketScans.set(scanKey, evalPromise);

      // Await within Zendesk's webhook SLA so Cloud Run keeps CPU active until Gemini + writeback finish
      const finished = await Promise.race([
        evalPromise.then((res) => ({ completed: res !== null })),
        new Promise<{ completed: boolean }>((resolve) =>
          setTimeout(() => resolve({ completed: false }), 7_500),
        ),
      ]);
      return c.json({ ok: true, queued: true, completed: finished.completed });
    }

    return c.json({ ok: true, queued: false });
  });

  // Paddle Billing Webhook Receiver (Sandbox in dev, Live only after Phase 4 approval)
  app.post('/webhooks/paddle', async (c) => {
    const rawBody = await c.req.text();
    const result = await billing.handleWebhook(rawBody, c.req.header('paddle-signature'));
    if (!result.accepted) {
      return c.json({ error: result.reason ?? 'Webhook rejected' }, 401);
    }
    return c.json({ ok: true, ...result });
  });

  // Serve built frontend static files when running in unified single-container mode (Cloud Run)
  const frontendDist = path.resolve(process.cwd(), 'frontend', 'dist');
  if (fs.existsSync(frontendDist)) {
    app.get('*', (c) => {
      const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
      const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
      const fullPath = path.join(frontendDist, safePath);
      const filePath = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()
        ? fullPath
        : path.join(frontendDist, 'index.html');
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.json': 'application/json',
        '.woff2': 'font/woff2',
      };
      return new Response(fs.readFileSync(filePath), {
        headers: { 'Content-Type': mimeMap[ext] ?? 'application/octet-stream' },
      });
    });
  }

  return app;
}
