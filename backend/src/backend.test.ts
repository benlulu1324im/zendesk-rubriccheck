import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { SqliteRepository } from './db/repository.js';
import {
  decryptSecret,
  encryptSecret,
  verifyPaddleWebhookSignature,
  verifyRs256Jwt,
  verifyZendeskWebhookSignature,
} from './utils/crypto.js';

describe('Crypto & Webhook Verification', () => {
  it('encrypts and decrypts OAuth tokens using AES-256-GCM', () => {
    const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const cipher = encryptSecret('zd_refresh_token_secret_123', key);
    expect(cipher).not.toContain('zd_refresh_token_secret_123');
    expect(decryptSecret(cipher, key)).toBe('zd_refresh_token_secret_123');
  });

  it('verifies Zendesk HMAC-SHA256 webhook signatures and rejects tampered payloads', () => {
    const secret = 'whsec_test_zendesk_secret';
    const timestamp = new Date().toISOString();
    const rawBody = JSON.stringify({ type: 'zen:event-type:ticket.comment_added', detail: { id: 42 } });
    const sig = crypto
      .createHmac('sha256', secret)
      .update(timestamp + rawBody, 'utf8')
      .digest('base64');

    expect(
      verifyZendeskWebhookSignature({ signature: sig, timestamp, rawBody, signingSecret: secret }),
    ).toBe(true);
    expect(
      verifyZendeskWebhookSignature({
        signature: sig,
        timestamp,
        rawBody: rawBody + ' ',
        signingSecret: secret,
      }),
    ).toBe(false);
    expect(
      verifyZendeskWebhookSignature({
        signature: sig,
        timestamp: '2020-01-01T00:00:00Z',
        rawBody,
        signingSecret: secret,
      }),
    ).toBe(false);
  });

  it('verifies Paddle-Signature header including rotated h1 signatures', () => {
    const secret = 'pdl_ntfset_sandbox_secret_key';
    const ts = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ event_id: 'evt_1', event_type: 'subscription.created' });
    const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');

    expect(
      verifyPaddleWebhookSignature({
        signatureHeader: `ts=${ts};h1=deadbeef;h1=${h1}`,
        rawBody,
        secretKey: secret,
      }),
    ).toBe(true);
    expect(
      verifyPaddleWebhookSignature({
        signatureHeader: `ts=${ts};h1=${h1}`,
        rawBody: rawBody + 'tampered',
        secretKey: secret,
      }),
    ).toBe(false);
  });

  it('strictly verifies RS256 ZAF JWT and rejects alg=none and HS256 confusion', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const now = Math.floor(Date.now() / 1000);

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: 'https://acme.zendesk.com', sub: '123', exp: now + 300 }),
    ).toString('base64url');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    const sig = signer.sign(privateKey).toString('base64url');

    const verified = verifyRs256Jwt(`${header}.${payload}.${sig}`, pubPem, now);
    expect(verified.iss).toBe('https://acme.zendesk.com');

    // Reject alg=none
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(() => verifyRs256Jwt(`${noneHeader}.${payload}.`, pubPem, now)).toThrow(/Disallowed/);

    // Reject HS256 signed with public key PEM
    const hsHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const hsSig = crypto
      .createHmac('sha256', pubPem)
      .update(`${hsHeader}.${payload}`)
      .digest('base64url');
    expect(() => verifyRs256Jwt(`${hsHeader}.${payload}.${hsSig}`, pubPem, now)).toThrow(/Disallowed/);
  });
});

describe('RubricCheck Backend End-to-End Flows', () => {
  let repo: SqliteRepository;
  let app: ReturnType<typeof createApp>;
  const webhookSecret = 'pdl_ntfset_test_secret_123';

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    const config = loadConfig({
      NODE_ENV: 'test',
      ZENDESK_DEV_MODE: 'true',
      PADDLE_ENV: 'sandbox',
      PADDLE_WEBHOOK_SECRET: webhookSecret,
    });
    app = createApp({ config, repo });
  });

  afterEach(() => {
    repo.close();
  });

  async function getDevToken(subdomain = 'acme-help'): Promise<string> {
    const res = await app.request('/api/session/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subdomain }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { token: string };
    return data.token;
  }

  function signPaddleBody(rawBody: string): string {
    const ts = String(Math.floor(Date.now() / 1000));
    const h1 = crypto.createHmac('sha256', webhookSecret).update(`${ts}:${rawBody}`).digest('hex');
    return `ts=${ts};h1=${h1}`;
  }

  it('evaluates multimodal ticket with fake credit-card screenshot, flags PII, and redacts in one click', async () => {
    const token = await getDevToken('acme-help');

    const simRes = await app.request('/api/tickets/simulate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ticketId: '10482',
        subject: 'Double charge on my Visa card',
        assigneeName: 'Noa Tal',
        transcriptText:
          'Customer: Attached a photo of my Visa card 4532-1190-8821-4242 for refund.\nAgent: Thank you! I verified your invoice and refunded the duplicate charge today.',
        attachments: [
          {
            attachmentId: 'att_991',
            commentId: 'cmt_551',
            filename: 'visa_credit_card_photo.png',
            mimeType: 'image/png',
            base64Data: Buffer.from('fake-png-bytes').toString('base64'),
          },
        ],
      }),
    });

    expect(simRes.status).toBe(200);
    const outcome = (await simRes.json()) as {
      evaluation: { overallScore: number; piiDetected: boolean; piiSeverity: string };
      piiFindings: Array<{ id: string; status: string; piiCategories: string[] }>;
    };
    expect(outcome.evaluation.piiDetected).toBe(true);
    expect(outcome.evaluation.piiSeverity).toBe('critical');
    expect(outcome.piiFindings).toHaveLength(1);
    expect(outcome.piiFindings[0].status).toBe('flagged');
    expect(outcome.piiFindings[0].piiCategories).toContain('credit_card');

    // One-click redact
    const redactRes = await app.request(`/api/pii/${outcome.piiFindings[0].id}/redact`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(redactRes.status).toBe(200);
    const redacted = (await redactRes.json()) as { finding: { status: string } };
    expect(redacted.finding.status).toBe('redacted');
  });

  it('syncs Paddle Sandbox subscription upgrades/cancellations idempotently and enforces CSV export gating', async () => {
    const token = await getDevToken('beta-corp');

    // Free plan cannot export CSV
    const deniedCsv = await app.request('/api/dashboard/export.csv', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(deniedCsv.status).toBe(403);

    // Upgrade to Growth via signed Paddle Sandbox webhook
    const subCreated = JSON.stringify({
      event_id: 'evt_growth_001',
      event_type: 'subscription.created',
      data: {
        id: 'sub_01testgrowth',
        status: 'active',
        customer_id: 'ctm_01testbeta',
        custom_data: { zendesk_subdomain: 'beta-corp' },
        items: [{ price: { id: 'pri_01m87xv1426zzdjy3r85v7fp1b' } }],
      },
    });
    const wh1 = await app.request('/webhooks/paddle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Paddle-Signature': signPaddleBody(subCreated),
      },
      body: subCreated,
    });
    expect(wh1.status).toBe(200);

    // Replay same event_id -> idempotent duplicate
    const whDup = await app.request('/webhooks/paddle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Paddle-Signature': signPaddleBody(subCreated),
      },
      body: subCreated,
    });
    const dupJson = (await whDup.json()) as { duplicate?: boolean };
    expect(dupJson.duplicate).toBe(true);

    // Now CSV export succeeds on Growth
    const allowedCsv = await app.request('/api/dashboard/export.csv', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(allowedCsv.status).toBe(200);
    expect(allowedCsv.headers.get('content-type')).toContain('text/csv');

    // Cancel subscription -> downgrades cleanly to Free
    const subCanceled = JSON.stringify({
      event_id: 'evt_cancel_002',
      event_type: 'subscription.canceled',
      data: {
        id: 'sub_01testgrowth',
        status: 'canceled',
        customer_id: 'ctm_01testbeta',
        custom_data: { app: 'rubriccheck-qa', zendesk_subdomain: 'beta-corp' },
      },
    });
    const whCancel = await app.request('/webhooks/paddle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Paddle-Signature': signPaddleBody(subCanceled),
      },
      body: subCanceled,
    });
    expect(whCancel.status).toBe(200);

    const overview = (await (
      await app.request('/api/dashboard/overview', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { tenant: { planTier: string; monthlyTicketLimit: number } };
    expect(overview.tenant.planTier).toBe('free');
    expect(overview.tenant.monthlyTicketLimit).toBe(100);
  });

  it('silently returns 200 OK (ignored) for unrelated products in the shared Paddle account', async () => {
    const unrelatedFramerEvent = JSON.stringify({
      event_id: 'evt_framer_999',
      event_type: 'transaction.completed',
      data: {
        id: 'txn_01framer',
        status: 'completed',
        customer_id: 'ctm_01framer',
        custom_data: { zendesk_subdomain: 'should-not-create' },
        items: [
          {
            price: {
              id: 'pri_01m83ay6jgcfnkgv9jyqsvx203',
              product_id: 'pro_01m83ax6abynzgmb9bxk3xbqtp',
            },
          },
        ],
      },
    });

    const res = await app.request('/webhooks/paddle', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Paddle-Signature': signPaddleBody(unrelatedFramerEvent),
      },
      body: unrelatedFramerEvent,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ignored?: boolean };
    expect(body.ok).toBe(true);
    expect(body.ignored).toBe(true);
    expect(await repo.getTenantBySubdomain('should-not-create')).toBeNull();
  });
});
