import type { AppConfig } from '../config.js';
import type { Repository, TenantRecord } from '../db/repository.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import type { InMemoryAttachment } from './geminiDecision.js';

export interface ZendeskTicketBundle {
  ticketId: string;
  subject: string;
  status: string;
  assigneeName: string;
  tags: string[];
  transcriptText: string;
  attachments: InMemoryAttachment[];
}

const SUPPORTED_MEDIA_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

const MAX_ATTACHMENTS_PER_TICKET = 6;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export class ZendeskClient {
  private readonly refreshLocks = new Map<string, Promise<string>>();

  constructor(
    private readonly config: AppConfig,
    private readonly repo: Repository,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  buildAuthorizeUrl(subdomain: string, signedState: string): string {
    const clean = subdomain.trim().toLowerCase();
    const redirectUri = `${this.config.appBaseUrl}/oauth/zendesk/callback`;
    const params = new URLSearchParams({
      response_type: 'code',
      redirect_uri: redirectUri,
      client_id: this.config.zendeskOAuthClientId,
      scope: this.config.zendeskOAuthScopes,
      state: signedState,
    });
    return `https://${clean}.zendesk.com/oauth/authorizations/new?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    subdomain: string,
    code: string,
  ): Promise<{ accessToken: string; refreshToken: string | null; expiresInSec: number }> {
    const clean = subdomain.trim().toLowerCase();
    const redirectUri = `${this.config.appBaseUrl}/oauth/zendesk/callback`;
    const res = await this.fetchImpl(`https://${clean}.zendesk.com/oauth/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: this.config.zendeskOAuthClientId,
        client_secret: this.config.zendeskOAuthClientSecret,
        redirect_uri: redirectUri,
        scope: this.config.zendeskOAuthScopes,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Zendesk OAuth token exchange failed (${res.status}): ${txt.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresInSec: data.expires_in ?? 1800, // Zendesk 2026 default: 30m access token TTL
    };
  }

  async getValidAccessToken(tenant: TenantRecord): Promise<string> {
    if (!tenant.oauthAccessTokenEnc) {
      throw new Error(`Zendesk OAuth is not connected for ${tenant.zendeskSubdomain}`);
    }

    const expiresAtMs = tenant.oauthExpiresAt ? Date.parse(tenant.oauthExpiresAt) : 0;
    const isNearExpiry = expiresAtMs > 0 && Date.now() >= expiresAtMs - 120_000;

    if (!isNearExpiry) {
      return decryptSecret(tenant.oauthAccessTokenEnc, this.config.encryptionKey);
    }

    if (!tenant.oauthRefreshTokenEnc) {
      return decryptSecret(tenant.oauthAccessTokenEnc, this.config.encryptionKey);
    }

    // Deduplicate concurrent refresh rotations per tenant
    const existingLock = this.refreshLocks.get(tenant.id);
    if (existingLock) return existingLock;

    const refreshPromise = this.performTokenRefresh(tenant).finally(() => {
      this.refreshLocks.delete(tenant.id);
    });
    this.refreshLocks.set(tenant.id, refreshPromise);
    return refreshPromise;
  }

  private async performTokenRefresh(tenant: TenantRecord): Promise<string> {
    const refreshToken = decryptSecret(tenant.oauthRefreshTokenEnc!, this.config.encryptionKey);
    const res = await this.fetchImpl(
      `https://${tenant.zendeskSubdomain}.zendesk.com/oauth/tokens`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.config.zendeskOAuthClientId,
          client_secret: this.config.zendeskOAuthClientSecret,
          scope: this.config.zendeskOAuthScopes,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Zendesk OAuth refresh failed (${res.status}): ${txt.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const expiresAt = new Date(Date.now() + (data.expires_in ?? 1800) * 1000).toISOString();
    await this.repo.updateTenantOAuth(tenant.id, {
      accessTokenEnc: encryptSecret(data.access_token, this.config.encryptionKey),
      refreshTokenEnc: data.refresh_token
        ? encryptSecret(data.refresh_token, this.config.encryptionKey)
        : null,
      expiresAt,
    });

    return data.access_token;
  }

  private async zdFetch(tenant: TenantRecord, path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getValidAccessToken(tenant);
    const url = path.startsWith('http')
      ? path
      : `https://${tenant.zendeskSubdomain}.zendesk.com${path}`;
    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (init.body !== undefined) {
      baseHeaders['Content-Type'] = 'application/json';
    }
    return this.fetchImpl(url, {
      ...init,
      headers: {
        ...baseHeaders,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
  }

  async provisionEventWebhook(
    tenant: TenantRecord,
  ): Promise<{ webhookId: string; signingSecret: string }> {
    const endpoint = `${this.config.appBaseUrl}/webhooks/zendesk?subdomain=${encodeURIComponent(tenant.zendeskSubdomain)}`;
    let webhookId: string | null = null;

    // Reuse an existing RubricCheck webhook targeting the same endpoint to avoid duplicates on OAuth re-connect
    try {
      const listRes = await this.zdFetch(
        tenant,
        '/api/v2/webhooks?filter[name_contains]=RubricCheck',
        { method: 'GET' },
      );
      if (listRes.ok) {
        const listData = (await listRes.json()) as {
          webhooks?: Array<{ id: string; endpoint?: string; status?: string }>;
        };
        const existing = (listData.webhooks ?? []).find(
          (w) => w.endpoint === endpoint && w.status === 'active',
        );
        if (existing) {
          webhookId = existing.id;
        }
      }
    } catch {
      // Fall through and create a fresh webhook
    }

    if (!webhookId) {
      const createRes = await this.zdFetch(tenant, '/api/v2/webhooks', {
        method: 'POST',
        body: JSON.stringify({
          webhook: {
            name: 'RubricCheck QA & PII Guardrail',
            description:
              'Real-time screenshot/PDF PII guardrail and automated ticket QA rubric evaluation.',
            status: 'active',
            endpoint,
            http_method: 'POST',
            request_format: 'json',
            subscriptions: [
              'zen:event-type:ticket.attachment_linked_to_comment',
              'zen:event-type:ticket.comment_added',
              'zen:event-type:ticket.status_changed',
              'zen:event-type:ticket.attachment_redacted_from_comment',
            ],
          },
        }),
      });

      if (!createRes.ok) {
        const txt = await createRes.text().catch(() => '');
        throw new Error(`Zendesk webhook provisioning failed (${createRes.status}): ${txt.slice(0, 300)}`);
      }

      const created = (await createRes.json()) as { webhook: { id: string } };
      webhookId = created.webhook.id;
    }

    const secretRes = await this.zdFetch(tenant, `/api/v2/webhooks/${webhookId}/signing_secret`, {
      method: 'GET',
    });
    if (!secretRes.ok) {
      throw new Error(`Failed to fetch Zendesk webhook signing secret (${secretRes.status})`);
    }
    const secretPayload = (await secretRes.json()) as {
      signing_secret: { secret: string };
    };
    const signingSecret = secretPayload.signing_secret.secret;

    await this.repo.updateTenantWebhook(
      tenant.id,
      webhookId,
      encryptSecret(signingSecret, this.config.encryptionKey),
    );
    return { webhookId, signingSecret };
  }

  async fetchTicketBundle(tenant: TenantRecord, ticketId: string): Promise<ZendeskTicketBundle> {
    const [ticketRes, commentsRes] = await Promise.all([
      this.zdFetch(tenant, `/api/v2/tickets/${encodeURIComponent(ticketId)}.json?include=users`),
      this.zdFetch(tenant, `/api/v2/tickets/${encodeURIComponent(ticketId)}/comments.json`),
    ]);

    if (!ticketRes.ok) {
      throw new Error(`Failed to fetch Zendesk ticket ${ticketId} (${ticketRes.status})`);
    }
    if (!commentsRes.ok) {
      throw new Error(`Failed to fetch Zendesk comments for ${ticketId} (${commentsRes.status})`);
    }

    const ticketData = (await ticketRes.json()) as {
      ticket: {
        id: number;
        subject?: string;
        status?: string;
        assignee_id?: number | null;
        requester_id?: number | null;
        tags?: string[];
      };
      users?: Array<{ id: number; name?: string; role?: string }>;
    };

    const commentsData = (await commentsRes.json()) as {
      comments: Array<{
        id: number;
        author_id: number;
        public: boolean;
        body?: string;
        created_at: string;
        attachments?: Array<{
          id: number;
          file_name: string;
          content_url: string;
          content_type: string;
          size: number;
          deleted?: boolean;
        }>;
      }>;
    };

    const userMap = new Map<number, { name: string; role: string }>();
    for (const u of ticketData.users ?? []) {
      userMap.set(u.id, { name: u.name ?? `User ${u.id}`, role: u.role ?? 'end-user' });
    }

    const assignee = ticketData.ticket.assignee_id
      ? userMap.get(ticketData.ticket.assignee_id)?.name ?? `Agent #${ticketData.ticket.assignee_id}`
      : 'Unassigned';

    const lines: string[] = [
      `Ticket #${ticketData.ticket.id} | Status: ${ticketData.ticket.status ?? 'unknown'}`,
      `Subject: ${ticketData.ticket.subject ?? '(no subject)'}`,
      `Assignee: ${assignee}`,
      '--- Conversation Transcript ---',
    ];

    const attachments: InMemoryAttachment[] = [];
    let totalMediaBytes = 0;

    for (const c of commentsData.comments) {
      const author = userMap.get(c.author_id);
      const roleLabel =
        author?.role === 'agent' || author?.role === 'admin'
          ? `AGENT (${author.name})`
          : `CUSTOMER (${author?.name ?? 'Requester'})`;
      const visibility = c.public ? 'Public' : 'Internal Note';
      lines.push(`[${c.created_at}] ${roleLabel} [${visibility}]:\n${c.body ?? ''}\n`);

      for (const att of c.attachments ?? []) {
        if (att.deleted) continue;
        if (attachments.length >= MAX_ATTACHMENTS_PER_TICKET) continue;
        const mime = (att.content_type || '').toLowerCase();
        if (!SUPPORTED_MEDIA_MIMES.has(mime)) continue;
        const maxSingle = mime === 'application/pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
        if (att.size > maxSingle || totalMediaBytes + att.size > MAX_TOTAL_BYTES) continue;

        try {
          const mediaRes = await this.zdFetch(tenant, att.content_url, {
            method: 'GET',
            headers: { Accept: '*/*' },
          });
          if (!mediaRes.ok) continue;
          const bytes = Buffer.from(await mediaRes.arrayBuffer());
          if (bytes.byteLength > maxSingle || totalMediaBytes + bytes.byteLength > MAX_TOTAL_BYTES) {
            continue;
          }
          totalMediaBytes += bytes.byteLength;
          attachments.push({
            attachmentId: String(att.id),
            commentId: String(c.id),
            filename: att.file_name,
            contentUrl: att.content_url,
            mimeType: mime === 'image/jpg' ? 'image/jpeg' : mime,
            bytes,
          });
        } catch {
          // Skip unreadable attachment without aborting ticket evaluation
        }
      }
    }

    return {
      ticketId: String(ticketData.ticket.id),
      subject: ticketData.ticket.subject ?? '',
      status: ticketData.ticket.status ?? 'open',
      assigneeName: assignee,
      tags: ticketData.ticket.tags ?? [],
      transcriptText: lines.join('\n'),
      attachments,
    };
  }

  async applyTicketTagsAndNote(
    tenant: TenantRecord,
    ticketId: string,
    opts: { additionalTags: string[]; internalNote?: string },
  ): Promise<void> {
    const ticketPayload: Record<string, unknown> = {};
    if (opts.additionalTags.length > 0) {
      ticketPayload.additional_tags = opts.additionalTags;
    }
    if (opts.internalNote) {
      ticketPayload.comment = {
        body: opts.internalNote,
        public: false,
      };
    }
    if (Object.keys(ticketPayload).length === 0) return;

    const res = await this.zdFetch(tenant, `/api/v2/tickets/${encodeURIComponent(ticketId)}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ticket: ticketPayload }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Zendesk ticket update failed (${res.status}): ${txt.slice(0, 300)}`);
    }
  }

  /**
   * Permanently redacts an attachment from a Zendesk ticket comment (works even on closed tickets).
   * Verified late-2026 endpoint: PUT /api/v2/comment_redactions/{ticket_comment_id}
   */
  async redactAttachment(
    tenant: TenantRecord,
    ticketId: string,
    commentId: string,
    attachmentUrl: string,
  ): Promise<void> {
    const res = await this.zdFetch(
      tenant,
      `/api/v2/comment_redactions/${encodeURIComponent(commentId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          ticket_id: Number(ticketId),
          external_attachment_urls: [attachmentUrl],
        }),
      },
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Zendesk attachment redaction failed (${res.status}): ${txt.slice(0, 300)}`);
    }
  }
}
