import crypto from 'node:crypto';

const AES_ALGO = 'aes-256-gcm';

export function encryptSecret(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) {
    throw new Error('Encryption key must be 32 bytes (64 hex characters)');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(ciphertext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, 'hex');
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies Zendesk Webhook authenticity:
 * Expected = Base64(HMAC-SHA256(timestamp + rawBody, signingSecret))
 */
export function verifyZendeskWebhookSignature(params: {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
  signingSecret: string;
  maxAgeSeconds?: number;
  nowMs?: number;
}): boolean {
  const { signature, timestamp, rawBody, signingSecret, maxAgeSeconds = 300, nowMs = Date.now() } =
    params;
  if (!signature || !timestamp || !signingSecret) return false;

  const parsedTs = Date.parse(timestamp);
  if (Number.isNaN(parsedTs)) return false;
  if (Math.abs(nowMs - parsedTs) > maxAgeSeconds * 1000) return false;

  const expected = crypto
    .createHmac('sha256', signingSecret)
    .update(timestamp + (rawBody ?? ''), 'utf8')
    .digest('base64');

  return timingSafeCompare(signature.trim(), expected);
}

/**
 * Verifies Paddle Billing Webhook authenticity:
 * Header format: ts=<unix_seconds>;h1=<hex_sig>(;h1=<rotated_sig>)
 * Signed payload: `${ts}:${rawBody}`
 */
export function verifyPaddleWebhookSignature(params: {
  signatureHeader: string | undefined;
  rawBody: string;
  secretKey: string;
  maxAgeSeconds?: number;
  nowMs?: number;
}): boolean {
  const { signatureHeader, rawBody, secretKey, maxAgeSeconds = 300, nowMs = Date.now() } = params;
  if (!signatureHeader || !secretKey) return false;

  let ts: string | null = null;
  const h1Signatures: string[] = [];

  for (const part of signatureHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key === 'ts') ts = val;
    if (key === 'h1' && val) h1Signatures.push(val);
  }

  if (!ts || h1Signatures.length === 0) return false;
  const tsSeconds = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsSeconds)) return false;
  if (Math.abs(nowMs - tsSeconds * 1000) > maxAgeSeconds * 1000) return false;

  const expected = crypto
    .createHmac('sha256', secretKey)
    .update(`${ts}:${rawBody}`, 'utf8')
    .digest('hex');

  return h1Signatures.some((sig) => timingSafeCompare(sig, expected));
}

function b64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecodeJson<T>(segment: string): T {
  const raw = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(raw) as T;
}

export function signHs256Jwt<T extends Record<string, unknown>>(
  payload: T,
  secret: string,
  expiresInSeconds: number,
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(JSON.stringify({ ...payload, iat: nowSec, exp: nowSec + expiresInSeconds }));
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyHs256Jwt<T extends Record<string, unknown>>(
  token: string,
  secret: string,
): T {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT structure');
  const [headerSeg, payloadSeg, sigSeg] = parts;
  const header = b64urlDecodeJson<{ alg?: string }>(headerSeg);
  if (header.alg !== 'HS256') throw new Error('Unsupported JWT algorithm');

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${headerSeg}.${payloadSeg}`)
    .digest('base64url');

  if (!timingSafeCompare(sigSeg, expectedSig)) {
    throw new Error('Invalid JWT signature');
  }

  const payload = b64urlDecodeJson<T & { exp?: number }>(payloadSeg);
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && nowSec >= payload.exp) {
    throw new Error('JWT expired');
  }
  return payload;
}

/**
 * Strictly verifies RS256-signed Zendesk ZAF signedUrls JWTs against the app's PEM public key.
 * Rejects any non-RS256 algorithm (prevents alg=none and HS256 confusion attacks).
 */
export function verifyRs256Jwt<T extends Record<string, unknown>>(
  token: string,
  publicKeyPem: string,
  nowSec = Math.floor(Date.now() / 1000),
): T {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT structure');
  const [headerSeg, payloadSeg, sigSeg] = parts;
  const header = b64urlDecodeJson<{ alg?: string }>(headerSeg);
  if (header.alg !== 'RS256') {
    throw new Error(`Disallowed JWT algorithm: ${String(header.alg)}`);
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerSeg}.${payloadSeg}`);
  verifier.end();

  const signatureBytes = Buffer.from(sigSeg, 'base64url');
  const valid = verifier.verify(publicKeyPem, signatureBytes);
  if (!valid) {
    throw new Error('Invalid RS256 JWT signature');
  }

  const payload = b64urlDecodeJson<T & { exp?: number; nbf?: number }>(payloadSeg);
  if (typeof payload.exp === 'number' && nowSec >= payload.exp) {
    throw new Error('ZAF JWT expired');
  }
  if (typeof payload.nbf === 'number' && nowSec < payload.nbf - 30) {
    throw new Error('ZAF JWT not yet valid');
  }
  return payload;
}

export function decodeJwtPayloadUnsafe<T extends Record<string, unknown>>(token: string): T {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT structure');
  return b64urlDecodeJson<T>(parts[1]);
}
