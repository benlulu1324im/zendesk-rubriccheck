import {
  PLAN_CATALOG,
  computeEvaluationFromDecisions,
  type PiiCategory,
} from '@rubriccheck/shared';
import type {
  EvaluationRecord,
  PiiFindingRecord,
  Repository,
  TenantRecord,
} from '../db/repository.js';
import type { GeminiDecisionEngine, InMemoryAttachment } from './geminiDecision.js';
import type { ZendeskClient } from './zendeskClient.js';

export interface EvaluateInputBundle {
  ticketId: string;
  subject: string;
  assigneeName: string;
  transcriptText: string;
  attachments: InMemoryAttachment[];
  rubricId?: string;
  writeBackToZendesk?: boolean;
}

export interface EvaluationOutcome {
  evaluation: EvaluationRecord;
  piiFindings: PiiFindingRecord[];
  autoRedactedAttachmentIds: string[];
  quota: { used: number; limit: number };
}

export class QuotaExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly limit: number,
    public readonly planTier: string,
  ) {
    super(`Monthly ticket quota reached (${used}/${limit} on ${planTier} plan)`);
    this.name = 'QuotaExceededError';
  }
}

export class EvaluationOrchestrator {
  constructor(
    private readonly repo: Repository,
    private readonly gemini: GeminiDecisionEngine,
    private readonly zendesk: ZendeskClient,
  ) {}

  async evaluateLiveZendeskTicket(
    tenant: TenantRecord,
    ticketId: string,
    rubricId?: string,
  ): Promise<EvaluationOutcome> {
    const bundle = await this.zendesk.fetchTicketBundle(tenant, ticketId);
    return this.evaluateBundle(tenant, {
      ticketId: bundle.ticketId,
      subject: bundle.subject,
      assigneeName: bundle.assigneeName,
      transcriptText: bundle.transcriptText,
      attachments: bundle.attachments,
      rubricId,
      writeBackToZendesk: true,
    });
  }

  async evaluateBundle(
    tenant: TenantRecord,
    input: EvaluateInputBundle,
  ): Promise<EvaluationOutcome> {
    const quota = await this.repo.consumeTicketQuota(tenant.id);
    if (!quota.allowed) {
      throw new QuotaExceededError(quota.used, quota.limit, tenant.planTier);
    }

    const rubric = input.rubricId
      ? (await this.repo.getRubricById(tenant.id, input.rubricId)) ??
        (await this.repo.getDefaultRubric(tenant.id))
      : await this.repo.getDefaultRubric(tenant.id);

    const planDef = PLAN_CATALOG[tenant.planTier];
    const attachmentSnapshots = input.attachments.map((a) => ({
      attachmentId: a.attachmentId,
      commentId: a.commentId,
      filename: a.filename,
      contentUrl: a.contentUrl,
    }));

    // Run multimodal evaluation while media buffers live transiently in RAM
    let execResult;
    try {
      execResult = await this.gemini.evaluate(rubric, input.transcriptText, input.attachments);
    } finally {
      // Explicitly release attachment buffers immediately after inference (zero persistence)
      input.attachments.length = 0;
    }

    const computed = computeEvaluationFromDecisions(
      rubric,
      execResult.response,
      planDef.autoRedact,
    );

    const evaluation = await this.repo.saveEvaluation({
      tenantId: tenant.id,
      ticketId: input.ticketId,
      ticketSubject: input.subject.slice(0, 140),
      assigneeName: input.assigneeName.slice(0, 80),
      rubricId: rubric.id,
      rubricName: rubric.name,
      overallScore: computed.overallScore,
      passed: computed.passed,
      hasCriticalFail: computed.hasCriticalFail,
      coachingPriority: computed.coachingPriority,
      piiDetected: computed.piiDetected,
      piiSeverity: computed.piiSeverity,
      criteriaResults: computed.criteriaResults,
      piiResults: computed.piiResults,
      modelUsed: execResult.modelUsed,
      inputTokens: execResult.inputTokens,
      latencyMs: execResult.latencyMs,
      attachmentCount: attachmentSnapshots.length,
    });

    const piiFindings: PiiFindingRecord[] = [];
    const autoRedactedAttachmentIds: string[] = [];

    if (computed.piiDetected) {
      const flaggedCategories: PiiCategory[] = computed.piiResults
        .filter((r) => r.flagged)
        .map((r) => r.category);
      const maxProb = Math.max(...computed.piiResults.map((r) => r.probability), 0);
      const maxConf = Math.max(...computed.piiResults.map((r) => r.confidence), 0);

      const targets =
        attachmentSnapshots.length > 0
          ? attachmentSnapshots
          : [
              {
                attachmentId: `text_${input.ticketId}`,
                commentId: '0',
                filename: 'Ticket Text / Message Body',
                contentUrl: '',
              },
            ];

      for (const att of targets) {
        let status: PiiFindingRecord['status'] = 'flagged';
        if (
          computed.piiAutoRedactEligible &&
          input.writeBackToZendesk &&
          tenant.oauthConnected &&
          att.contentUrl &&
          att.commentId !== '0'
        ) {
          try {
            await this.zendesk.redactAttachment(
              tenant,
              input.ticketId,
              att.commentId,
              att.contentUrl,
            );
            status = 'redacted';
            autoRedactedAttachmentIds.push(att.attachmentId);
          } catch {
            status = 'flagged';
          }
        }

        const finding = await this.repo.upsertPiiFinding({
          tenantId: tenant.id,
          evaluationId: evaluation.id,
          ticketId: input.ticketId,
          commentId: att.commentId,
          attachmentId: att.attachmentId,
          attachmentFilename: att.filename,
          attachmentUrl: att.contentUrl,
          piiCategories: flaggedCategories,
          maxProbability: maxProb,
          confidence: maxConf,
          status,
        });
        piiFindings.push(finding);
      }
    }

    // Write QA & PII tags back to Zendesk when connected
    if (input.writeBackToZendesk && tenant.oauthConnected && rubric.autoTagConfig.writeTagsToZendesk) {
      const tags: string[] = [
        computed.passed ? rubric.autoTagConfig.passTag : rubric.autoTagConfig.reviewTag,
      ];
      if (computed.piiDetected) {
        tags.push(rubric.autoTagConfig.piiTag);
      }
      if (autoRedactedAttachmentIds.length > 0) {
        tags.push(rubric.autoTagConfig.redactedTag);
      }

      let internalNote: string | undefined;
      const alreadyNotified = input.transcriptText.includes('[RubricCheck PII Guardrail]');
      if (computed.piiDetected && rubric.autoTagConfig.addInternalNoteOnPii && (!alreadyNotified || autoRedactedAttachmentIds.length > 0)) {
        const cats = computed.piiResults
          .filter((r) => r.flagged)
          .map((r) => `${r.label} (${Math.round(r.probability * 100)}%)`)
          .join(', ');
        internalNote =
          autoRedactedAttachmentIds.length > 0
            ? `[RubricCheck PII Guardrail] Exposed sensitive data (${cats}) was automatically redacted from ${autoRedactedAttachmentIds.length} attachment(s). QA Score: ${computed.overallScore}/100.`
            : `[RubricCheck PII Guardrail] Warning: Potential exposed PII detected (${cats}) with severity ${computed.piiSeverity.toUpperCase()}. Open the RubricCheck sidebar to inspect and redact in one click.`;
      }

      try {
        await this.zendesk.applyTicketTagsAndNote(tenant, input.ticketId, {
          additionalTags: tags,
          internalNote,
        });
      } catch (writeErr) {
        console.warn(
          `[zendesk] Writeback failed for ${tenant.zendeskSubdomain}#${input.ticketId}:`,
          (writeErr as Error).message,
        );
      }
    }

    return {
      evaluation,
      piiFindings,
      autoRedactedAttachmentIds,
      quota: { used: quota.used, limit: quota.limit },
    };
  }
}
