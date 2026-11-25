import { z } from 'zod';

export const PlanTierSchema = z.enum(['free', 'starter', 'growth', 'scale']);
export type PlanTier = z.infer<typeof PlanTierSchema>;

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  tagline: string;
  monthlyUsd: number;
  annualMonthlyUsd: number;
  annualTotalUsd: number;
  monthlyTicketLimit: number;
  maxRubrics: number;
  maxCriteriaPerRubric: number;
  autoRedact: boolean;
  csvExport: boolean;
  multiBrand: boolean;
  webhookAlerts: boolean;
}

export const PLAN_CATALOG: Record<PlanTier, PlanDefinition> = {
  free: {
    tier: 'free',
    name: 'Free',
    tagline: 'Try multimodal QA & PII scanning on live tickets',
    monthlyUsd: 0,
    annualMonthlyUsd: 0,
    annualTotalUsd: 0,
    monthlyTicketLimit: 100,
    maxRubrics: 1,
    maxCriteriaPerRubric: 5,
    autoRedact: false,
    csvExport: false,
    multiBrand: false,
    webhookAlerts: false,
  },
  starter: {
    tier: 'starter',
    name: 'Starter',
    tagline: 'For growing support teams (5–15 agents)',
    monthlyUsd: 79,
    annualMonthlyUsd: 69,
    annualTotalUsd: 828,
    monthlyTicketLimit: 1500,
    maxRubrics: 3,
    maxCriteriaPerRubric: 15,
    autoRedact: false,
    csvExport: false,
    multiBrand: false,
    webhookAlerts: true,
  },
  growth: {
    tier: 'growth',
    name: 'Growth',
    tagline: 'Automated QA + hands-free PII auto-redaction (15–30 agents)',
    monthlyUsd: 149,
    annualMonthlyUsd: 129,
    annualTotalUsd: 1548,
    monthlyTicketLimit: 5000,
    maxRubrics: 100,
    maxCriteriaPerRubric: 30,
    autoRedact: true,
    csvExport: true,
    multiBrand: false,
    webhookAlerts: true,
  },
  scale: {
    tier: 'scale',
    name: 'Scale',
    tagline: 'High-volume multi-brand QA & compliance (30–40+ agents)',
    monthlyUsd: 299,
    annualMonthlyUsd: 249,
    annualTotalUsd: 2988,
    monthlyTicketLimit: 15000,
    maxRubrics: 500,
    maxCriteriaPerRubric: 50,
    autoRedact: true,
    csvExport: true,
    multiBrand: true,
    webhookAlerts: true,
  },
};

export const PiiCategorySchema = z.enum([
  'credit_card',
  'gov_id',
  'ssn_national_id',
  'api_key_secret',
  'password_credentials',
  'bank_iban',
]);
export type PiiCategory = z.infer<typeof PiiCategorySchema>;

export const PII_CATEGORY_META: Record<
  PiiCategory,
  {
    label: string;
    instructions: string;
    trueDescription: string;
    falseDescription: string;
  }
> = {
  credit_card: {
    label: 'Credit / Debit Card',
    instructions:
      'Does any attached screenshot, PDF, or message contain a full or nearly full payment card number (12-19 digits), CVV/CVC security code, or visible photo of a physical credit/debit card?',
    trueDescription:
      'A full card number, photo of a physical card, or card number paired with expiration/CVV is visible.',
    falseDescription:
      'Only masked digits (e.g. **** 4242), last 4 digits, order IDs, phone numbers, or invoice numbers appear.',
  },
  gov_id: {
    label: 'Government ID / Passport',
    instructions:
      'Does any attached image or PDF depict a government-issued photo ID, passport, driver license, or national identity card?',
    trueDescription:
      'A scan, photo, or screenshot showing a passport, driver license, visa, or national ID card.',
    falseDescription:
      'No government identification document is shown; only product screenshots, receipts, or error logs.',
  },
  ssn_national_id: {
    label: 'SSN / National Tax ID',
    instructions:
      'Does any attached image, PDF, or text expose an unmasked Social Security Number (SSN), National ID number, or personal Tax Identification Number?',
    trueDescription:
      'An unmasked SSN (e.g. 123-45-6789), Teudat Zehut, NIN, or personal tax ID is clearly visible.',
    falseDescription:
      'No personal national ID or SSN is shown, or it is fully redacted/masked.',
  },
  api_key_secret: {
    label: 'API Key / Private Token',
    instructions:
      'Does any attached screenshot, log, PDF, or message expose a live API key, secret token, private key block, OAuth bearer token, or webhook signing secret?',
    trueDescription:
      'An unmasked secret such as sk_live_, AIza, ghp_, AKIA, Bearer JWT, or PEM private key is visible.',
    falseDescription:
      'No secrets are exposed, or values are clearly placeholder text like YOUR_API_KEY or masked.',
  },
  password_credentials: {
    label: 'Plaintext Password',
    instructions:
      'Does any attached screenshot, PDF, or message reveal a plaintext user password, PIN code, recovery seed phrase, or MFA backup codes?',
    trueDescription:
      'An actual plaintext password, 2FA recovery codes, or crypto seed phrase is visibly shared.',
    falseDescription:
      'Password fields are masked with dots/asterisks or only a password-reset link is discussed.',
  },
  bank_iban: {
    label: 'Bank Account / IBAN',
    instructions:
      'Does any attached screenshot, PDF bank statement, or message expose a personal bank account number paired with routing/sort code or full IBAN?',
    trueDescription:
      'A bank statement, voided check, or screenshot with full personal IBAN or routing + account number.',
    falseDescription:
      'Only standard vendor invoice wire info, masked account numbers, or no banking numbers appear.',
  },
};

export const ImageResolutionSchema = z.enum(['low', 'medium', 'high', 'ultra_high']);
export type ImageResolution = z.infer<typeof ImageResolutionSchema>;

export const PiiConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    categories: z.record(PiiCategorySchema, z.boolean()).default({
      credit_card: true,
      gov_id: true,
      ssn_national_id: true,
      api_key_secret: true,
      password_credentials: true,
      bank_iban: true,
    }),
    flagThreshold: z.number().min(0.5).max(0.99).default(0.72),
    autoRedactEnabled: z.boolean().default(false),
    autoRedactAcknowledgedIrreversible: z.boolean().default(false),
    autoRedactThreshold: z.number().min(0.95).max(0.99).default(0.95),
    imageResolution: ImageResolutionSchema.default('high'),
  })
  .refine(
    (cfg) => !cfg.autoRedactEnabled || cfg.autoRedactAcknowledgedIrreversible === true,
    {
      message:
        'Explicit admin acknowledgment of irreversible Zendesk attachment deletion is required to enable Auto-Redact.',
      path: ['autoRedactAcknowledgedIrreversible'],
    },
  );
export type PiiConfig = z.infer<typeof PiiConfigSchema>;

const CriterionKeySchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[A-Za-z0-9_-]+$/, 'Key must be alphanumeric with underscores or hyphens');

export const ScoreCriterionSchema = z.object({
  id: CriterionKeySchema,
  kind: z.literal('score'),
  label: z.string().min(1).max(80),
  instructions: z.string().min(5).max(600),
  weight: z.number().min(1).max(100),
  levels: z.array(z.string().min(2).max(240)).min(2).max(5),
  criticalFailBelow: z.number().min(0).max(4).optional(),
});

export const NoulCriterionSchema = z.object({
  id: CriterionKeySchema,
  kind: z.literal('noul'),
  label: z.string().min(1).max(80),
  instructions: z.string().min(5).max(600),
  weight: z.number().min(1).max(100),
  trueDescription: z.string().min(2).max(300).optional(),
  falseDescription: z.string().min(2).max(300).optional(),
  passThreshold: z.number().min(0.5).max(0.99).default(0.65),
  criticalFail: z.boolean().default(false),
});

export const RubricCriterionSchema = z.discriminatedUnion('kind', [
  ScoreCriterionSchema,
  NoulCriterionSchema,
]);
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const AutoTagConfigSchema = z.object({
  writeTagsToZendesk: z.boolean().default(true),
  addInternalNoteOnPii: z.boolean().default(true),
  passTag: z.string().min(1).max(40).default('rc_qa_pass'),
  reviewTag: z.string().min(1).max(40).default('rc_qa_review'),
  piiTag: z.string().min(1).max(40).default('rc_pii_exposed'),
  redactedTag: z.string().min(1).max(40).default('rc_pii_redacted'),
});
export type AutoTagConfig = z.infer<typeof AutoTagConfigSchema>;

export const RubricInputSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(300).default(''),
  isDefault: z.boolean().default(false),
  passScoreThreshold: z.number().min(0).max(100).default(75),
  criteria: z.array(RubricCriterionSchema).min(1).max(50),
  piiConfig: PiiConfigSchema,
  autoTagConfig: AutoTagConfigSchema,
});
export type RubricInput = z.infer<typeof RubricInputSchema>;

export interface RubricRecord extends RubricInput {
  id: string;
  tenantId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// Gemini Decisions API v1beta schemas (verified Nov 2026 official spec)
export interface DecisionQuestionNoul {
  type: 'noul';
  instructions: string;
  criteria?: {
    true_description: string;
    false_description: string;
  };
}

export interface DecisionQuestionChoice {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface DecisionQuestionScore {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type DecisionQuestion =
  | DecisionQuestionNoul
  | DecisionQuestionChoice
  | DecisionQuestionScore;

export const DecisionAnswerNoulSchema = z.object({
  type: z.literal('noul').optional(),
  noul: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
});

export const DecisionAnswerChoiceSchema = z.object({
  type: z.literal('choice').optional(),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()).optional(),
});

export const DecisionAnswerScoreSchema = z.object({
  type: z.literal('score').optional(),
  score: z.union([z.number(), z.string()]),
  confidence: z.number().min(0).max(1),
  probabilities: z.union([z.array(z.number()), z.record(z.string(), z.number())]).optional(),
  legend: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
});

export const DecisionAnswerSchema = z.union([
  DecisionAnswerNoulSchema,
  DecisionAnswerChoiceSchema,
  DecisionAnswerScoreSchema,
]);
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

export const DecisionApiResponseSchema = z.object({
  answers: z.record(z.string(), DecisionAnswerSchema),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      total_input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      total_output_tokens: z.number().optional(),
      input_tokens_by_modality: z
        .union([z.record(z.string(), z.number()), z.array(z.unknown())])
        .optional(),
    })
    .passthrough()
    .optional(),
});
export type DecisionApiResponse = z.infer<typeof DecisionApiResponseSchema>;

export interface CriterionEvaluationResult {
  criterionId: string;
  label: string;
  kind: 'score' | 'noul';
  weight: number;
  normalizedScore: number; // 0..100
  rawValue: number;
  maxValue: number;
  confidence: number;
  passed: boolean;
  criticalFailed: boolean;
}

export interface PiiCategoryResult {
  category: PiiCategory;
  label: string;
  probability: number;
  confidence: number;
  flagged: boolean;
  eligibleForAutoRedact: boolean;
}

export interface ComputedEvaluation {
  overallScore: number; // 0..100 integer
  passed: boolean;
  hasCriticalFail: boolean;
  coachingPriority: 'none' | 'light_tip' | 'manager_review' | 'urgent_compliance';
  piiDetected: boolean;
  piiSeverity: 'none' | 'low' | 'high' | 'critical';
  piiAutoRedactEligible: boolean;
  piiResults: PiiCategoryResult[];
  criteriaResults: CriterionEvaluationResult[];
}
