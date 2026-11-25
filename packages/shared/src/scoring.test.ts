import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAAS_RUBRIC,
  PiiConfigSchema,
  RUBRIC_TEMPLATES,
  buildDecisionQuestions,
  computeEvaluationFromDecisions,
  type DecisionApiResponse,
} from './index.js';

describe('buildDecisionQuestions', () => {
  it('builds prefixed QA score/noul questions plus PII noul checks and severity/coaching choices', () => {
    const questions = buildDecisionQuestions(DEFAULT_SAAS_RUBRIC);
    expect(questions['qa_empathy_tone']?.type).toBe('score');
    expect(questions['qa_no_unauthorized_promises']?.type).toBe('noul');
    expect(questions['pii_credit_card']?.type).toBe('noul');
    expect(questions['pii_gov_id']?.type).toBe('noul');
    expect(questions['pii_api_key_secret']?.type).toBe('noul');
    expect(questions['pii_severity']?.type).toBe('choice');
    expect(questions['coaching_priority']?.type).toBe('choice');
  });

  it('keeps Auto-Redact OFF by default across all rubric templates and enforces >= 0.95 floor + explicit acknowledgment', () => {
    for (const tpl of RUBRIC_TEMPLATES) {
      expect(tpl.piiConfig.autoRedactEnabled).toBe(false);
      expect(tpl.piiConfig.autoRedactAcknowledgedIrreversible).toBe(false);
      expect(tpl.piiConfig.autoRedactThreshold).toBeGreaterThanOrEqual(0.95);
    }

    // Reject enabling without explicit irreversibility acknowledgment
    const missingAck = PiiConfigSchema.safeParse({
      ...DEFAULT_SAAS_RUBRIC.piiConfig,
      autoRedactEnabled: true,
      autoRedactAcknowledgedIrreversible: false,
      autoRedactThreshold: 0.95,
    });
    expect(missingAck.success).toBe(false);

    // Reject threshold below 0.95
    const belowFloor = PiiConfigSchema.safeParse({
      ...DEFAULT_SAAS_RUBRIC.piiConfig,
      autoRedactEnabled: true,
      autoRedactAcknowledgedIrreversible: true,
      autoRedactThreshold: 0.92,
    });
    expect(belowFloor.success).toBe(false);
  });
});

describe('computeEvaluationFromDecisions', () => {
  it('calculates weighted score, detects exposed PII, and enforces opt-in 0.95+ auto-redact safety lock', () => {
    const mockResponse: DecisionApiResponse = {
      answers: {
        qa_empathy_tone: { type: 'score', score: 3.5, confidence: 0.91 },
        qa_accuracy_clarity: { type: 'score', score: 3.0, confidence: 0.88 },
        qa_resolution_completeness: { type: 'score', score: 4.0, confidence: 0.94 },
        qa_no_unauthorized_promises: { type: 'noul', noul: 0.96, confidence: 0.95 },
        qa_acknowledged_attachments: { type: 'noul', noul: 0.89, confidence: 0.9 },
        pii_credit_card: { type: 'noul', noul: 0.97, confidence: 0.96 },
        pii_gov_id: { type: 'noul', noul: 0.04, confidence: 0.97 },
        pii_ssn_national_id: { type: 'noul', noul: 0.02, confidence: 0.98 },
        pii_api_key_secret: { type: 'noul', noul: 0.05, confidence: 0.95 },
        pii_password_credentials: { type: 'noul', noul: 0.01, confidence: 0.99 },
        pii_bank_iban: { type: 'noul', noul: 0.03, confidence: 0.96 },
        pii_severity: { type: 'choice', choice: 'critical', confidence: 0.96 },
        coaching_priority: { type: 'choice', choice: 'none', confidence: 0.85 },
      },
      usage: { input_tokens: 4210, output_tokens: 0 },
    };

    const rubricWithAutoRedact = {
      ...DEFAULT_SAAS_RUBRIC,
      piiConfig: {
        ...DEFAULT_SAAS_RUBRIC.piiConfig,
        autoRedactEnabled: true,
        autoRedactAcknowledgedIrreversible: true,
        autoRedactThreshold: 0.95,
      },
    };

    // Starter plan does NOT allow auto-redact
    const starterEval = computeEvaluationFromDecisions(rubricWithAutoRedact, mockResponse, false);
    expect(starterEval.overallScore).toBeGreaterThanOrEqual(85);
    expect(starterEval.passed).toBe(true);
    expect(starterEval.piiDetected).toBe(true);
    expect(starterEval.piiSeverity).toBe('critical');
    expect(starterEval.piiAutoRedactEligible).toBe(false);
    expect(starterEval.coachingPriority).toBe('urgent_compliance');

    // Growth plan allows auto-redact ONLY when acknowledged AND both probability & confidence >= 0.95
    const growthEval = computeEvaluationFromDecisions(rubricWithAutoRedact, mockResponse, true);
    expect(growthEval.piiAutoRedactEligible).toBe(true);
    expect(growthEval.piiResults.find((r) => r.category === 'credit_card')?.eligibleForAutoRedact).toBe(
      true,
    );

    // Block auto-redact if confidence drops below 0.95 even when probability is 0.97
    const lowConfResponse: DecisionApiResponse = {
      ...mockResponse,
      answers: {
        ...mockResponse.answers,
        pii_credit_card: { type: 'noul', noul: 0.97, confidence: 0.91 },
      },
    };
    const lowConfEval = computeEvaluationFromDecisions(rubricWithAutoRedact, lowConfResponse, true);
    expect(lowConfEval.piiDetected).toBe(true);
    expect(lowConfEval.piiAutoRedactEligible).toBe(false);
  });

  it('fails the ticket if a critical-fail noul criterion fails regardless of score', () => {
    const mockResponse: DecisionApiResponse = {
      answers: {
        qa_empathy_tone: { type: 'score', score: 4.0, confidence: 0.95 },
        qa_accuracy_clarity: { type: 'score', score: 4.0, confidence: 0.95 },
        qa_resolution_completeness: { type: 'score', score: 4.0, confidence: 0.95 },
        qa_no_unauthorized_promises: { type: 'noul', noul: 0.15, confidence: 0.92 },
        qa_acknowledged_attachments: { type: 'noul', noul: 0.95, confidence: 0.94 },
        pii_severity: { type: 'choice', choice: 'none', confidence: 0.99 },
        coaching_priority: { type: 'choice', choice: 'manager_review', confidence: 0.9 },
      },
    };

    const res = computeEvaluationFromDecisions(DEFAULT_SAAS_RUBRIC, mockResponse, false);
    expect(res.overallScore).toBeGreaterThan(85);
    expect(res.hasCriticalFail).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.coachingPriority).toBe('urgent_compliance');
  });
});
