import {
  PII_CATEGORY_META,
  type ComputedEvaluation,
  type CriterionEvaluationResult,
  type DecisionApiResponse,
  type DecisionQuestion,
  type PiiCategory,
  type PiiCategoryResult,
  type RubricInput,
} from './schemas.js';

export function buildDecisionQuestions(rubric: RubricInput): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {};

  for (const criterion of rubric.criteria) {
    const key = `qa_${criterion.id}`;
    if (criterion.kind === 'score') {
      questions[key] = {
        type: 'score',
        instructions: criterion.instructions,
        criteria: criterion.levels,
      };
    } else {
      questions[key] = {
        type: 'noul',
        instructions: criterion.instructions,
        ...(criterion.trueDescription && criterion.falseDescription
          ? {
              criteria: {
                true_description: criterion.trueDescription,
                false_description: criterion.falseDescription,
              },
            }
          : {}),
      };
    }
  }

  if (rubric.piiConfig.enabled) {
    const categories = Object.keys(PII_CATEGORY_META) as PiiCategory[];
    for (const cat of categories) {
      if (rubric.piiConfig.categories[cat]) {
        const meta = PII_CATEGORY_META[cat];
        questions[`pii_${cat}`] = {
          type: 'noul',
          instructions: meta.instructions,
          criteria: {
            true_description: meta.trueDescription,
            false_description: meta.falseDescription,
          },
        };
      }
    }

    questions['pii_severity'] = {
      type: 'choice',
      instructions:
        'What is the overall severity of exposed sensitive PII across the ticket text and attached images or PDFs?',
      criteria: {
        none: 'No sensitive PII or secrets exposed anywhere in text, images, or PDFs.',
        low: 'Minor personal contact details only (email or phone) without financial, ID, or credential exposure.',
        high: 'Sensitive personal data exposed such as bank account details, partial credentials, or personal ID numbers.',
        critical:
          'High-risk exposure such as full credit/debit card, passport/driver license photo, SSN, live API key, or plaintext password.',
      },
    };
  }

  questions['coaching_priority'] = {
    type: 'choice',
    instructions:
      'Based on the agent responses and policy adherence in this ticket, what level of QA coaching follow-up is recommended?',
    criteria: {
      none: 'Agent handled the ticket well; no coaching needed.',
      light_tip: 'Minor opportunity to improve clarity, formatting, or proactive follow-up.',
      manager_review: 'Notable rubric miss, incomplete resolution, or tone issue needing QA lead review.',
      urgent_compliance: 'Critical policy violation, wrong promise, or unredacted sensitive data exposure.',
    },
  };

  return questions;
}

export function computeEvaluationFromDecisions(
  rubric: RubricInput,
  response: DecisionApiResponse,
  planAllowsAutoRedact: boolean,
): ComputedEvaluation {
  const criteriaResults: CriterionEvaluationResult[] = [];
  let weightedSum = 0;
  let totalWeight = 0;
  let hasCriticalFail = false;

  for (const criterion of rubric.criteria) {
    const key = `qa_${criterion.id}`;
    const ans = response.answers[key];
    totalWeight += criterion.weight;

    if (!ans) {
      criteriaResults.push({
        criterionId: criterion.id,
        label: criterion.label,
        kind: criterion.kind,
        weight: criterion.weight,
        normalizedScore: 0,
        rawValue: 0,
        maxValue: criterion.kind === 'score' ? criterion.levels.length - 1 : 1,
        confidence: 0,
        passed: false,
        criticalFailed: criterion.kind === 'noul' ? criterion.criticalFail : false,
      });
      continue;
    }

    if (criterion.kind === 'score' && 'score' in ans) {
      const maxIndex = Math.max(1, criterion.levels.length - 1);
      const numericScore =
        typeof ans.score === 'number'
          ? ans.score
          : Math.max(0, criterion.levels.indexOf(ans.score));
      const clamped = Math.max(0, Math.min(maxIndex, numericScore));
      const normalized = Math.round((clamped / maxIndex) * 100);
      const criticalFailed =
        criterion.criticalFailBelow !== undefined && clamped < criterion.criticalFailBelow;
      if (criticalFailed) hasCriticalFail = true;
      const passed = !criticalFailed && normalized >= rubric.passScoreThreshold;

      weightedSum += normalized * criterion.weight;
      criteriaResults.push({
        criterionId: criterion.id,
        label: criterion.label,
        kind: 'score',
        weight: criterion.weight,
        normalizedScore: normalized,
        rawValue: Number(clamped.toFixed(2)),
        maxValue: maxIndex,
        confidence: Number(ans.confidence.toFixed(3)),
        passed,
        criticalFailed,
      });
    } else if (criterion.kind === 'noul' && 'noul' in ans) {
      const prob = Math.max(0, Math.min(1, ans.noul));
      const passed = prob >= criterion.passThreshold;
      const normalized = passed ? 100 : Math.round(prob * 100);
      const criticalFailed = !passed && criterion.criticalFail;
      if (criticalFailed) hasCriticalFail = true;

      weightedSum += normalized * criterion.weight;
      criteriaResults.push({
        criterionId: criterion.id,
        label: criterion.label,
        kind: 'noul',
        weight: criterion.weight,
        normalizedScore: normalized,
        rawValue: Number(prob.toFixed(3)),
        maxValue: 1,
        confidence: Number(ans.confidence.toFixed(3)),
        passed,
        criticalFailed,
      });
    }
  }

  const overallScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  // Compute PII guardrail results
  const piiResults: PiiCategoryResult[] = [];
  if (rubric.piiConfig.enabled) {
    const categories = Object.keys(PII_CATEGORY_META) as PiiCategory[];
    for (const cat of categories) {
      if (!rubric.piiConfig.categories[cat]) continue;
      const ans = response.answers[`pii_${cat}`];
      const prob = ans && 'noul' in ans ? Math.max(0, Math.min(1, ans.noul)) : 0;
      const conf = ans ? Math.max(0, Math.min(1, ans.confidence)) : 0;
      const flagged = prob >= rubric.piiConfig.flagThreshold;
      const strictThreshold = Math.max(0.95, rubric.piiConfig.autoRedactThreshold);
      const eligibleForAutoRedact =
        planAllowsAutoRedact &&
        rubric.piiConfig.autoRedactEnabled === true &&
        rubric.piiConfig.autoRedactAcknowledgedIrreversible === true &&
        prob >= strictThreshold &&
        conf >= 0.95;

      piiResults.push({
        category: cat,
        label: PII_CATEGORY_META[cat].label,
        probability: Number(prob.toFixed(3)),
        confidence: Number(conf.toFixed(3)),
        flagged,
        eligibleForAutoRedact,
      });
    }
  }

  const piiDetected = piiResults.some((r) => r.flagged);
  const piiAutoRedactEligible = piiResults.some((r) => r.eligibleForAutoRedact);

  const severityAns = response.answers['pii_severity'];
  let piiSeverity: ComputedEvaluation['piiSeverity'] = 'none';
  if (severityAns && 'choice' in severityAns) {
    const v = severityAns.choice;
    if (v === 'none' || v === 'low' || v === 'high' || v === 'critical') {
      piiSeverity = v;
    }
  }
  if (piiDetected && (piiSeverity === 'none' || piiSeverity === 'low')) {
    const maxP = Math.max(...piiResults.filter((r) => r.flagged).map((r) => r.probability));
    piiSeverity = maxP >= 0.9 ? 'critical' : 'high';
  }
  if (!piiDetected) {
    piiSeverity = 'none';
  }

  const coachAns = response.answers['coaching_priority'];
  let coachingPriority: ComputedEvaluation['coachingPriority'] = 'none';
  if (coachAns && 'choice' in coachAns) {
    const v = coachAns.choice;
    if (
      v === 'none' ||
      v === 'light_tip' ||
      v === 'manager_review' ||
      v === 'urgent_compliance'
    ) {
      coachingPriority = v;
    }
  }
  if (piiDetected || hasCriticalFail) {
    coachingPriority = 'urgent_compliance';
  }

  const passed = !hasCriticalFail && overallScore >= rubric.passScoreThreshold;

  return {
    overallScore,
    passed,
    hasCriticalFail,
    coachingPriority,
    piiDetected,
    piiSeverity,
    piiAutoRedactEligible,
    piiResults,
    criteriaResults,
  };
}
