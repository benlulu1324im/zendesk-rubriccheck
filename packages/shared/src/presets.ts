import type { RubricInput } from './schemas.js';

export const DEFAULT_SAAS_RUBRIC: RubricInput = {
  name: 'SaaS Support Quality & PII Guardrail',
  description:
    'Balanced SMB support rubric covering empathy, accuracy, resolution, identity safety, and screenshot/PDF PII protection.',
  isDefault: true,
  passScoreThreshold: 75,
  criteria: [
    {
      id: 'empathy_tone',
      kind: 'score',
      label: 'Empathy & Professional Tone',
      instructions:
        'Rate how empathetic, calm, polite, and brand-appropriate the support agent tone is across all agent replies in the ticket.',
      weight: 25,
      levels: [
        'Rude, dismissive, defensive, or unprofessional language.',
        'Robotic or curt; ignores customer frustration.',
        'Polite and neutral but misses clear warmth or personalization.',
        'Warm, clear, respectful, and acknowledges customer context.',
        'Exceptional empathy, reassurance, and tailored brand voice throughout.',
      ],
      criticalFailBelow: 1,
    },
    {
      id: 'accuracy_clarity',
      kind: 'score',
      label: 'Technical Accuracy & Clarity',
      instructions:
        'Rate how clear, accurate, and easy to follow the agent explanation and troubleshooting steps are, including references to any customer screenshots or PDFs.',
      weight: 30,
      levels: [
        'Incorrect or misleading advice that could break customer workflows.',
        'Confusing, jargon-heavy, or misses key details shown in screenshots/attachments.',
        'Mostly correct but vague or requires avoidable back-and-forth.',
        'Clear, accurate, well-structured steps directly addressing the evidence.',
        'Crystal-clear, verified, well-formatted solution with helpful preventive context.',
      ],
    },
    {
      id: 'resolution_completeness',
      kind: 'score',
      label: 'Resolution & Ownership',
      instructions:
        'Rate whether the agent resolved the root issue completely or provided concrete next steps and ownership before closing.',
      weight: 25,
      levels: [
        'Ticket left unresolved or closed prematurely without addressing the issue.',
        'Partial answer that ignores secondary questions in the thread.',
        'Addresses main question but leaves next steps ambiguous.',
        'Fully resolves the customer request with clear confirmation.',
        'Resolves root cause completely and proactively prevents recurrence.',
      ],
    },
    {
      id: 'no_unauthorized_promises',
      kind: 'noul',
      label: 'Policy Compliance (No Unauthorized Promises)',
      instructions:
        'Did the agent avoid making unauthorized legal, SLA, refund, or roadmap guarantees outside standard support policy?',
      weight: 10,
      trueDescription: 'Agent stayed within standard support boundaries and did not make unauthorized promises.',
      falseDescription: 'Agent made unauthorized legal, financial, or unapproved feature guarantees.',
      passThreshold: 0.65,
      criticalFail: true,
    },
    {
      id: 'acknowledged_attachments',
      kind: 'noul',
      label: 'Reviewed Attached Screenshots / PDFs',
      instructions:
        'If attachments (screenshots, invoices, PDFs) were provided, did the agent properly inspect and respond to the details inside them? Answer yes if no attachments were sent.',
      weight: 10,
      trueDescription: 'Agent addressed attachment details accurately, or no attachments were included.',
      falseDescription: 'Customer sent an attachment that the agent ignored or contradicted.',
      passThreshold: 0.6,
      criticalFail: false,
    },
  ],
  piiConfig: {
    enabled: true,
    categories: {
      credit_card: true,
      gov_id: true,
      ssn_national_id: true,
      api_key_secret: true,
      password_credentials: true,
      bank_iban: true,
    },
    flagThreshold: 0.72,
    autoRedactEnabled: false,
    autoRedactAcknowledgedIrreversible: false,
    autoRedactThreshold: 0.95,
    imageResolution: 'high',
  },
  autoTagConfig: {
    writeTagsToZendesk: true,
    addInternalNoteOnPii: true,
    passTag: 'rc_qa_pass',
    reviewTag: 'rc_qa_review',
    piiTag: 'rc_pii_exposed',
    redactedTag: 'rc_pii_redacted',
  },
};

export const ECOMMERCE_RUBRIC_TEMPLATE: RubricInput = {
  name: 'E-Commerce Orders, Damage & Refunds',
  description:
    'Evaluates damage-photo verification, refund/replacement accuracy, and customer payment-card screenshot protection.',
  isDefault: false,
  passScoreThreshold: 75,
  criteria: [
    {
      id: 'damage_verification',
      kind: 'score',
      label: 'Visual Evidence & Order Verification',
      instructions:
        'Rate how accurately the agent verified order details and attached product/receipt photos before issuing a resolution.',
      weight: 35,
      levels: [
        'Ignored attached photo/receipt or processed refund blindly.',
        'Missed obvious details visible in the customer image.',
        'Verified basic order info but missed confirming replacement details.',
        'Accurately reviewed photo/receipt and confirmed order details.',
        'Thoroughly verified evidence, explained policy clearly, and expedited resolution.',
      ],
    },
    {
      id: 'deescalation_empathy',
      kind: 'score',
      label: 'De-escalation & Warmth',
      instructions:
        'Rate how effectively the agent de-escalated frustration and maintained a helpful, empathetic brand tone.',
      weight: 35,
      levels: [
        'Argued with customer or sounded blaming.',
        'Dry template reply with no empathy.',
        'Polite standard reply.',
        'Empathetic apology and reassuring ownership.',
        'Outstanding hospitality that turns a bad delivery into brand loyalty.',
      ],
    },
    {
      id: 'clear_timeline',
      kind: 'noul',
      label: 'Clear Refund / Shipping Timeline',
      instructions:
        'Did the agent provide an explicit timeframe for the refund, replacement shipment, or next follow-up?',
      weight: 30,
      trueDescription: 'Explicit business days or tracking timeline provided.',
      falseDescription: 'No timeframe given for when the customer should expect money or replacement.',
      passThreshold: 0.65,
      criticalFail: false,
    },
  ],
  piiConfig: DEFAULT_SAAS_RUBRIC.piiConfig,
  autoTagConfig: DEFAULT_SAAS_RUBRIC.autoTagConfig,
};

export const FINTECH_COMPLIANCE_TEMPLATE: RubricInput = {
  name: 'Fintech & Regulated KYC Support',
  description:
    'Strict compliance scorecard enforcing identity verification, accurate regulatory guidance, and aggressive ID/card redaction.',
  isDefault: false,
  passScoreThreshold: 80,
  criteria: [
    {
      id: 'kyc_verification',
      kind: 'noul',
      label: 'Identity Verification Before Account Action',
      instructions:
        'Did the agent verify customer identity before sharing sensitive account information or performing account changes?',
      weight: 35,
      trueDescription: 'Identity was verified or no protected account data was disclosed.',
      falseDescription: 'Agent disclosed or modified sensitive account details without verifying identity.',
      passThreshold: 0.7,
      criticalFail: true,
    },
    {
      id: 'regulatory_accuracy',
      kind: 'score',
      label: 'Financial & Policy Accuracy',
      instructions:
        'Rate the accuracy of the agent explanation regarding fees, transfers, disputes, or account holds.',
      weight: 40,
      levels: [
        'Materially inaccurate financial or compliance statement.',
        'Ambiguous or partially incorrect policy guidance.',
        'Accurate high-level explanation but omits important caveats.',
        'Accurate, compliant, and clearly documented explanation.',
        'Exemplary precision with clear citations to policy and exact timelines.',
      ],
      criticalFailBelow: 2,
    },
    {
      id: 'reassurance_tone',
      kind: 'score',
      label: 'Calm Reassurance & Clarity',
      instructions:
        'Rate how clearly and reassuringly the agent communicated during a potentially stressful financial inquiry.',
      weight: 25,
      levels: [
        'Alarming, rude, or dismissive.',
        'Cold and overly bureaucratic.',
        'Professional and adequate.',
        'Calm, reassuring, and easy to understand.',
        'Exceptionally trustworthy, transparent, and empathetic.',
      ],
    },
  ],
  piiConfig: {
    ...DEFAULT_SAAS_RUBRIC.piiConfig,
    flagThreshold: 0.65,
    autoRedactEnabled: false,
    autoRedactAcknowledgedIrreversible: false,
    autoRedactThreshold: 0.95,
  },
  autoTagConfig: DEFAULT_SAAS_RUBRIC.autoTagConfig,
};

export const RUBRIC_TEMPLATES = [
  DEFAULT_SAAS_RUBRIC,
  ECOMMERCE_RUBRIC_TEMPLATE,
  FINTECH_COMPLIANCE_TEMPLATE,
];
