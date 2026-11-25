import type { AppConfig } from '../config.js';
import { decodeJwtPayloadUnsafe, verifyRs256Jwt } from '../utils/crypto.js';

export interface VerifiedZafContext {
  subdomain: string;
  userId: string;
  email: string;
  name: string;
}

interface CachedKey {
  pem: string;
  fetchedAt: number;
}

const KEY_CACHE_TTL_MS = 60 * 60 * 1000;

export class ZafAuthService {
  private readonly keyCache = new Map<string, CachedKey>();

  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private extractSubdomainFromClaims(claims: Record<string, unknown>): string {
    const iss = String(claims.iss ?? '');
    // Zendesk ZAF signedUrls JWT iss is typically "https://{subdomain}.zendesk.com" or "{subdomain}"
    const match = iss.match(/^https?:\/\/([a-z0-9-]+)\.zendesk\.com/i);
    if (match) return match[1].toLowerCase();
    if (typeof claims.subdomain === 'string' && /^[a-z0-9-]+$/i.test(claims.subdomain)) {
      return claims.subdomain.toLowerCase();
    }
    throw new Error('Unable to determine Zendesk subdomain from ZAF JWT');
  }

  private async getPublicKeyPem(subdomain: string, forceRefresh = false): Promise<string> {
    if (!this.config.zendeskAppId) {
      throw new Error('ZENDESK_APP_ID is required to verify ZAF signedUrls JWT');
    }
    const cacheKey = `${subdomain}:${this.config.zendeskAppId}`;
    const cached = this.keyCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) {
      return cached.pem;
    }

    const url = `https://${subdomain}.zendesk.com/api/v2/apps/${encodeURIComponent(this.config.zendeskAppId)}/public_key.pem`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`Failed to fetch Zendesk app public key (${res.status})`);
    }
    const pem = await res.text();
    this.keyCache.set(cacheKey, { pem, fetchedAt: Date.now() });
    return pem;
  }

  async verifySignedUrlJwt(token: string): Promise<VerifiedZafContext> {
    const unverified = decodeJwtPayloadUnsafe<Record<string, unknown>>(token);
    const subdomain = this.extractSubdomainFromClaims(unverified);

    let verified: Record<string, unknown>;
    try {
      const pem = await this.getPublicKeyPem(subdomain, false);
      verified = verifyRs256Jwt(token, pem);
    } catch {
      // Retry once with a fresh public key in case of key rotation
      const freshPem = await this.getPublicKeyPem(subdomain, true);
      verified = verifyRs256Jwt(token, freshPem);
    }

    return {
      subdomain,
      userId: String(verified.sub ?? 'unknown'),
      email: String(verified.email ?? ''),
      name: String(verified.name ?? 'Zendesk Agent'),
    };
  }
}
