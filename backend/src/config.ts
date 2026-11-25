import type { PlanTier } from '@rubriccheck/shared';

export interface AppConfig {
  port: number;
  nodeEnv: string;
  appBaseUrl: string;
  frontendUrl: string;
  encryptionKey: string;
  sessionSecret: string;
  dbDriver: 'sqlite' | 'firestore';
  sqlitePath: string;
  gcpProjectId: string;
  geminiApiKey: string;
  geminiDecisionModel: string;
  geminiFallbackModel: string;
  geminiAllowFallback: boolean;
  zendeskAppId: string;
  zendeskOAuthClientId: string;
  zendeskOAuthClientSecret: string;
  zendeskOAuthScopes: string;
  zendeskDevMode: boolean;
  paddleEnv: 'sandbox' | 'production';
  paddleApiKey: string;
  paddleWebhookSecret: string;
  paddleClientToken: string;
  paddleProducts: {
    starter: string;
    growth: string;
    scale: string;
  };
  paddlePrices: {
    starter: { monthly: string; annual: string };
    growth: { monthly: string; annual: string };
    scale: { monthly: string; annual: string };
  };
}

// Verified Paddle Sandbox catalog IDs provisioned for RubricCheck QA (isolated from other products)
const SANDBOX_DEFAULT_PRODUCTS = {
  starter: 'pro_01m87xv07jarss0842vdrnw8dd',
  growth: 'pro_01m87xv0y4bkqkqzygzrqsptjm',
  scale: 'pro_01m87xv1hzfch3rv6dn50eaw7p',
};

const SANDBOX_DEFAULT_PRICES = {
  starter: {
    monthly: 'pri_01m87xv0dgg1ey63gdm8d09knf',
    annual: 'pri_01m87xv0mmgh48mc6vwmspq708',
  },
  growth: {
    monthly: 'pri_01m87xv1426zzdjy3r85v7fp1b',
    annual: 'pri_01m87xv19z63x9g1ajxr36baqh',
  },
  scale: {
    monthly: 'pri_01m87xv1qgc044n5j844zdczht',
    annual: 'pri_01m87xv1xn41n82swf4azvwxyv',
  },
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const paddleEnv = env.PADDLE_ENV === 'production' ? 'production' : 'sandbox';

  const encryptionKey =
    env.ENCRYPTION_KEY ??
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const sessionSecret = env.SESSION_SECRET ?? 'dev-only-session-secret-change-in-production-32chars';

  if (nodeEnv === 'production') {
    if (!env.ENCRYPTION_KEY || !/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY)) {
      throw new Error('ENCRYPTION_KEY must be a 64-char hex string in production');
    }
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 characters in production');
    }
  }

  return {
    port: Number(env.PORT ?? 8787),
    nodeEnv,
    appBaseUrl: (env.APP_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, ''),
    frontendUrl: (env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
    encryptionKey,
    sessionSecret,
    dbDriver: env.DB_DRIVER === 'firestore' ? 'firestore' : 'sqlite',
    sqlitePath: env.SQLITE_PATH ?? './data/rubriccheck.sqlite',
    gcpProjectId: env.GCP_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT ?? '',
    geminiApiKey: env.GEMINI_API_KEY ?? '',
    geminiDecisionModel: env.GEMINI_DECISION_MODEL ?? 'gemini-decision-1',
    geminiFallbackModel: env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.5-flash-lite',
    geminiAllowFallback: env.GEMINI_ALLOW_FALLBACK !== 'false',
    zendeskAppId: env.ZENDESK_APP_ID ?? '',
    zendeskOAuthClientId: env.ZENDESK_OAUTH_CLIENT_ID ?? 'zdg-rubriccheck-qa',
    zendeskOAuthClientSecret: env.ZENDESK_OAUTH_CLIENT_SECRET ?? '',
    zendeskOAuthScopes:
      env.ZENDESK_OAUTH_SCOPES ?? 'tickets:read tickets:write webhooks:read webhooks:write',
    zendeskDevMode: env.ZENDESK_DEV_MODE === 'true' || nodeEnv !== 'production',
    paddleEnv,
    paddleApiKey: env.PADDLE_API_KEY ?? '',
    paddleWebhookSecret: env.PADDLE_WEBHOOK_SECRET ?? '',
    paddleClientToken:
      env.PADDLE_CLIENT_TOKEN ??
      (paddleEnv === 'sandbox' ? 'test_3ba5393e297d523995d63e11244' : ''),
    paddleProducts: {
      starter: env.PADDLE_PRODUCT_STARTER ?? SANDBOX_DEFAULT_PRODUCTS.starter,
      growth: env.PADDLE_PRODUCT_GROWTH ?? SANDBOX_DEFAULT_PRODUCTS.growth,
      scale: env.PADDLE_PRODUCT_SCALE ?? SANDBOX_DEFAULT_PRODUCTS.scale,
    },
    paddlePrices: {
      starter: {
        monthly: env.PADDLE_PRICE_STARTER_MONTHLY ?? SANDBOX_DEFAULT_PRICES.starter.monthly,
        annual: env.PADDLE_PRICE_STARTER_ANNUAL ?? SANDBOX_DEFAULT_PRICES.starter.annual,
      },
      growth: {
        monthly: env.PADDLE_PRICE_GROWTH_MONTHLY ?? SANDBOX_DEFAULT_PRICES.growth.monthly,
        annual: env.PADDLE_PRICE_GROWTH_ANNUAL ?? SANDBOX_DEFAULT_PRICES.growth.annual,
      },
      scale: {
        monthly: env.PADDLE_PRICE_SCALE_MONTHLY ?? SANDBOX_DEFAULT_PRICES.scale.monthly,
        annual: env.PADDLE_PRICE_SCALE_ANNUAL ?? SANDBOX_DEFAULT_PRICES.scale.annual,
      },
    },
  };
}

export function resolvePlanTierFromPriceId(
  config: AppConfig,
  priceId: string | undefined | null,
): PlanTier | null {
  if (!priceId) return null;
  if (
    priceId === config.paddlePrices.starter.monthly ||
    priceId === config.paddlePrices.starter.annual
  ) {
    return 'starter';
  }
  if (
    priceId === config.paddlePrices.growth.monthly ||
    priceId === config.paddlePrices.growth.annual
  ) {
    return 'growth';
  }
  if (
    priceId === config.paddlePrices.scale.monthly ||
    priceId === config.paddlePrices.scale.annual
  ) {
    return 'scale';
  }
  return null;
}
