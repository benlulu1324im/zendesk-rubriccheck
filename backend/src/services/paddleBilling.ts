import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import { PLAN_CATALOG, type PlanTier } from '@rubriccheck/shared';
import { resolvePlanTierFromPriceId, type AppConfig } from '../config.js';
import type { Repository, TenantRecord } from '../db/repository.js';
import { verifyPaddleWebhookSignature } from '../utils/crypto.js';

interface PaddleWebhookEnvelope {
  event_id: string;
  event_type: string;
  data: {
    id?: string;
    status?: string;
    customer_id?: string;
    subscription_id?: string;
    custom_data?: Record<string, unknown> | null;
    items?: Array<{
      price?: { id?: string; product_id?: string };
      price_id?: string;
      product?: { id?: string };
      product_id?: string;
    }>;
  };
}

const APP_ISOLATION_KEY = 'rubriccheck-qa';

export class PaddleBillingService {
  private readonly sdk: Paddle | null;
  private readonly knownProductIds: Set<string>;
  private readonly knownPriceIds: Set<string>;

  constructor(
    private readonly config: AppConfig,
    private readonly repo: Repository,
  ) {
    this.sdk = config.paddleApiKey
      ? new Paddle(config.paddleApiKey, {
          environment:
            config.paddleEnv === 'production' ? Environment.production : Environment.sandbox,
        })
      : null;

    this.knownProductIds = new Set(
      [
        config.paddleProducts.starter,
        config.paddleProducts.growth,
        config.paddleProducts.scale,
      ].filter(Boolean),
    );
    this.knownPriceIds = new Set(
      [
        config.paddlePrices.starter.monthly,
        config.paddlePrices.starter.annual,
        config.paddlePrices.growth.monthly,
        config.paddlePrices.growth.annual,
        config.paddlePrices.scale.monthly,
        config.paddlePrices.scale.annual,
      ].filter(Boolean),
    );
  }

  /**
   * Shared Paddle Account Isolation Rule #3:
   * Only process events whose product_id, price_id, or custom_data.app belongs to RubricCheck QA.
   * Silently acknowledge (200 OK, ignored: true) all events belonging to other products in the account.
   */
  private isRubricCheckEvent(event: PaddleWebhookEnvelope): boolean {
    const customApp = event.data?.custom_data?.app;
    if (typeof customApp === 'string' && customApp !== APP_ISOLATION_KEY) {
      return false;
    }

    const items = event.data?.items ?? [];
    if (items.length > 0) {
      const matchesCatalog = items.some((item) => {
        const priceId = item.price?.id ?? item.price_id ?? '';
        const productId = item.product?.id ?? item.price?.product_id ?? item.product_id ?? '';
        return (
          (priceId !== '' && this.knownPriceIds.has(priceId)) ||
          (productId !== '' && this.knownProductIds.has(productId))
        );
      });
      return matchesCatalog;
    }

    // Events without line items (e.g. minimal subscription.canceled) must match explicit app tag
    return customApp === APP_ISOLATION_KEY;
  }

  getClientCheckoutConfig(tenant: TenantRecord) {
    return {
      environment: this.config.paddleEnv,
      clientToken: this.config.paddleClientToken,
      subdomain: tenant.zendeskSubdomain,
      currentTier: tenant.planTier,
      paddleStatus: tenant.paddleStatus,
      hasPortalAccess: Boolean(tenant.paddleCustomerId),
      prices: this.config.paddlePrices,
      plans: PLAN_CATALOG,
    };
  }

  async handleWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<{
    accepted: boolean;
    ignored?: boolean;
    duplicate?: boolean;
    eventType?: string;
    reason?: string;
  }> {
    if (this.config.paddleWebhookSecret) {
      const valid = verifyPaddleWebhookSignature({
        signatureHeader,
        rawBody,
        secretKey: this.config.paddleWebhookSecret,
      });
      if (!valid) {
        return { accepted: false, reason: 'Invalid Paddle-Signature' };
      }
    } else if (this.config.nodeEnv === 'production') {
      return { accepted: false, reason: 'PADDLE_WEBHOOK_SECRET not configured' };
    }

    const event = JSON.parse(rawBody) as PaddleWebhookEnvelope;
    if (!event.event_id || !event.event_type) {
      return { accepted: false, reason: 'Malformed Paddle webhook payload' };
    }

    // Shared Paddle account isolation: silently return 200 OK for unrelated products
    if (!this.isRubricCheckEvent(event)) {
      return {
        accepted: true,
        ignored: true,
        eventType: event.event_type,
        reason: 'Event belongs to another product in shared Paddle account',
      };
    }

    const isNew = await this.repo.recordBillingEventIfNew(event.event_id, event.event_type);
    if (!isNew) {
      return { accepted: true, duplicate: true, eventType: event.event_type };
    }

    const customData = event.data?.custom_data ?? {};
    const subdomain =
      typeof customData?.zendesk_subdomain === 'string'
        ? customData.zendesk_subdomain.trim().toLowerCase()
        : null;

    if (!subdomain) {
      return { accepted: true, eventType: event.event_type, reason: 'No zendesk_subdomain in custom_data' };
    }

    const firstItem = event.data.items?.[0];
    const priceId = firstItem?.price?.id ?? firstItem?.price_id ?? null;
    const tierFromPrice = resolvePlanTierFromPriceId(this.config, priceId);
    const tierFromCustom =
      customData?.tier === 'starter' ||
      customData?.tier === 'growth' ||
      customData?.tier === 'scale'
        ? (customData.tier as PlanTier)
        : null;
    const resolvedTier: PlanTier = tierFromPrice ?? tierFromCustom ?? 'starter';

    const status = event.data.status ?? null;
    const subscriptionId =
      event.event_type.startsWith('subscription.')
        ? event.data.id ?? null
        : event.data.subscription_id ?? null;

    switch (event.event_type) {
      case 'transaction.completed':
      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.activated': {
        // Keep paid tier active during active/trialing/past_due; downgrade on canceled/paused
        const activeStatuses = new Set(['active', 'trialing', 'past_due', 'completed']);
        const effectiveTier: PlanTier =
          !status || activeStatuses.has(status) ? resolvedTier : 'free';
        await this.repo.updateTenantBilling(subdomain, {
          planTier: effectiveTier,
          paddleCustomerId: event.data.customer_id ?? null,
          paddleSubscriptionId: subscriptionId,
          paddleStatus: status ?? 'active',
        });
        break;
      }
      case 'subscription.canceled':
      case 'subscription.paused': {
        await this.repo.updateTenantBilling(subdomain, {
          planTier: 'free',
          paddleCustomerId: event.data.customer_id ?? null,
          paddleSubscriptionId: subscriptionId,
          paddleStatus: status ?? (event.event_type === 'subscription.paused' ? 'paused' : 'canceled'),
        });
        break;
      }
      default:
        break;
    }

    return { accepted: true, eventType: event.event_type };
  }

  async createCustomerPortalUrl(tenant: TenantRecord): Promise<string> {
    if (!tenant.paddleCustomerId) {
      throw new Error('No Paddle subscription linked to this Zendesk account yet');
    }
    if (!this.sdk) {
      const host =
        this.config.paddleEnv === 'production'
          ? 'customer-portal.paddle.com'
          : 'sandbox-customer-portal.paddle.com';
      return `https://${host}/demo-session/${tenant.paddleCustomerId}`;
    }
    const subscriptionIds = tenant.paddleSubscriptionId ? [tenant.paddleSubscriptionId] : [];
    const session = await this.sdk.customerPortalSessions.create(
      tenant.paddleCustomerId,
      subscriptionIds,
    );
    return session.urls.general.overview;
  }
}
