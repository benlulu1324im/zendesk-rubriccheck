import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_SAAS_RUBRIC,
  PLAN_CATALOG,
  type ComputedEvaluation,
  type PiiCategory,
  type PlanTier,
  type RubricInput,
  type RubricRecord,
} from '@rubriccheck/shared';

export interface TenantRecord {
  id: string;
  zendeskSubdomain: string;
  zendeskAccountId: string | null;
  oauthAccessTokenEnc: string | null;
  oauthRefreshTokenEnc: string | null;
  oauthExpiresAt: string | null;
  oauthConnected: boolean;
  webhookId: string | null;
  webhookSecretEnc: string | null;
  planTier: PlanTier;
  paddleCustomerId: string | null;
  paddleSubscriptionId: string | null;
  paddleStatus: string | null;
  monthlyTicketCount: number;
  usageResetAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationRecord {
  id: string;
  tenantId: string;
  ticketId: string;
  ticketSubject: string;
  assigneeName: string;
  rubricId: string;
  rubricName: string;
  overallScore: number;
  passed: boolean;
  hasCriticalFail: boolean;
  coachingPriority: ComputedEvaluation['coachingPriority'];
  piiDetected: boolean;
  piiSeverity: ComputedEvaluation['piiSeverity'];
  criteriaResults: ComputedEvaluation['criteriaResults'];
  piiResults: ComputedEvaluation['piiResults'];
  modelUsed: string;
  inputTokens: number;
  latencyMs: number;
  attachmentCount: number;
  evaluatedAt: string;
}

export interface PiiFindingRecord {
  id: string;
  tenantId: string;
  evaluationId: string;
  ticketId: string;
  commentId: string;
  attachmentId: string;
  attachmentFilename: string;
  attachmentUrl: string;
  piiCategories: PiiCategory[];
  maxProbability: number;
  confidence: number;
  status: 'flagged' | 'redacted' | 'dismissed';
  redactedBy: string | null;
  redactedAt: string | null;
  createdAt: string;
}

export interface DashboardOverview {
  tenant: {
    zendeskSubdomain: string;
    oauthConnected: boolean;
    webhookActive: boolean;
    planTier: PlanTier;
    paddleStatus: string | null;
    monthlyTicketCount: number;
    monthlyTicketLimit: number;
    usageResetAt: string;
    hasPaddleCustomer: boolean;
  };
  metrics: {
    totalEvaluated: number;
    averageScore: number;
    passRate: number;
    activePiiAlerts: number;
    redactedCount: number;
    avgLatencyMs: number;
  };
  recentEvaluations: EvaluationRecord[];
  openPiiFindings: PiiFindingRecord[];
}

export interface Repository {
  getOrCreateTenant(subdomain: string): Promise<TenantRecord>;
  getTenantBySubdomain(subdomain: string): Promise<TenantRecord | null>;
  getTenantById(tenantId: string): Promise<TenantRecord | null>;
  updateTenantOAuth(
    tenantId: string,
    patch: {
      accessTokenEnc: string;
      refreshTokenEnc: string | null;
      expiresAt: string;
      zendeskAccountId?: string | null;
    },
  ): Promise<void>;
  updateTenantWebhook(
    tenantId: string,
    webhookId: string,
    webhookSecretEnc: string,
  ): Promise<void>;
  updateTenantBilling(
    subdomain: string,
    patch: {
      planTier: PlanTier;
      paddleCustomerId?: string | null;
      paddleSubscriptionId?: string | null;
      paddleStatus?: string | null;
    },
  ): Promise<TenantRecord>;
  consumeTicketQuota(tenantId: string): Promise<{ allowed: boolean; used: number; limit: number }>;
  listRubrics(tenantId: string): Promise<RubricRecord[]>;
  getRubricById(tenantId: string, rubricId: string): Promise<RubricRecord | null>;
  getDefaultRubric(tenantId: string): Promise<RubricRecord>;
  createRubric(tenantId: string, input: RubricInput): Promise<RubricRecord>;
  updateRubric(tenantId: string, rubricId: string, input: RubricInput): Promise<RubricRecord | null>;
  deleteRubric(tenantId: string, rubricId: string): Promise<boolean>;
  saveEvaluation(
    record: Omit<EvaluationRecord, 'id' | 'evaluatedAt'>,
  ): Promise<EvaluationRecord>;
  getLatestEvaluationForTicket(tenantId: string, ticketId: string): Promise<EvaluationRecord | null>;
  listEvaluations(tenantId: string, limit?: number): Promise<EvaluationRecord[]>;
  upsertPiiFinding(
    finding: Omit<PiiFindingRecord, 'id' | 'createdAt' | 'redactedBy' | 'redactedAt'>,
  ): Promise<PiiFindingRecord>;
  listPiiFindingsForTicket(tenantId: string, ticketId: string): Promise<PiiFindingRecord[]>;
  listPiiFindings(
    tenantId: string,
    status?: PiiFindingRecord['status'],
    limit?: number,
  ): Promise<PiiFindingRecord[]>;
  getPiiFindingById(tenantId: string, findingId: string): Promise<PiiFindingRecord | null>;
  markPiiFindingStatus(
    tenantId: string,
    findingId: string,
    status: 'redacted' | 'dismissed',
    actor: string,
  ): Promise<PiiFindingRecord | null>;
  markPiiFindingRedactedByAttachment(
    tenantId: string,
    ticketId: string,
    attachmentId: string,
    actor: string,
  ): Promise<void>;
  recordBillingEventIfNew(eventId: string, eventType: string): Promise<boolean>;
  getDashboardOverview(tenantId: string): Promise<DashboardOverview>;
  close(): void;
}

function nextMonthResetIso(from = new Date()): string {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 0, 0, 0));
  return next.toISOString();
}

export class SqliteRepository implements Repository {
  private readonly db: DatabaseSync;

  constructor(sqlitePath: string) {
    if (sqlitePath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
    }
    this.db = new DatabaseSync(sqlitePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        zendesk_subdomain TEXT NOT NULL UNIQUE,
        zendesk_account_id TEXT,
        oauth_access_token_enc TEXT,
        oauth_refresh_token_enc TEXT,
        oauth_expires_at TEXT,
        webhook_id TEXT,
        webhook_secret_enc TEXT,
        plan_tier TEXT NOT NULL DEFAULT 'free',
        paddle_customer_id TEXT,
        paddle_subscription_id TEXT,
        paddle_status TEXT,
        monthly_ticket_count INTEGER NOT NULL DEFAULT 0,
        usage_reset_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rubrics (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_default INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        pass_score_threshold INTEGER NOT NULL DEFAULT 75,
        criteria_json TEXT NOT NULL,
        pii_config_json TEXT NOT NULL,
        auto_tag_config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        ticket_id TEXT NOT NULL,
        ticket_subject TEXT NOT NULL DEFAULT '',
        assignee_name TEXT NOT NULL DEFAULT 'Unassigned',
        rubric_id TEXT NOT NULL,
        rubric_name TEXT NOT NULL,
        overall_score INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        has_critical_fail INTEGER NOT NULL DEFAULT 0,
        coaching_priority TEXT NOT NULL DEFAULT 'none',
        pii_detected INTEGER NOT NULL DEFAULT 0,
        pii_severity TEXT NOT NULL DEFAULT 'none',
        criteria_results_json TEXT NOT NULL,
        pii_results_json TEXT NOT NULL,
        model_used TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        evaluated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evaluations_tenant_ticket
        ON evaluations(tenant_id, ticket_id, evaluated_at DESC);

      CREATE TABLE IF NOT EXISTS pii_findings (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        evaluation_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        comment_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        attachment_filename TEXT NOT NULL,
        attachment_url TEXT NOT NULL,
        pii_categories_json TEXT NOT NULL,
        max_probability REAL NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'flagged',
        redacted_by TEXT,
        redacted_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, ticket_id, attachment_id)
      );

      CREATE TABLE IF NOT EXISTS billing_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );
    `);
  }

  private mapTenant(row: Record<string, unknown>): TenantRecord {
    return {
      id: String(row.id),
      zendeskSubdomain: String(row.zendesk_subdomain),
      zendeskAccountId: row.zendesk_account_id ? String(row.zendesk_account_id) : null,
      oauthAccessTokenEnc: row.oauth_access_token_enc ? String(row.oauth_access_token_enc) : null,
      oauthRefreshTokenEnc: row.oauth_refresh_token_enc
        ? String(row.oauth_refresh_token_enc)
        : null,
      oauthExpiresAt: row.oauth_expires_at ? String(row.oauth_expires_at) : null,
      oauthConnected: Boolean(row.oauth_access_token_enc),
      webhookId: row.webhook_id ? String(row.webhook_id) : null,
      webhookSecretEnc: row.webhook_secret_enc ? String(row.webhook_secret_enc) : null,
      planTier: (row.plan_tier as PlanTier) || 'free',
      paddleCustomerId: row.paddle_customer_id ? String(row.paddle_customer_id) : null,
      paddleSubscriptionId: row.paddle_subscription_id ? String(row.paddle_subscription_id) : null,
      paddleStatus: row.paddle_status ? String(row.paddle_status) : null,
      monthlyTicketCount: Number(row.monthly_ticket_count ?? 0),
      usageResetAt: String(row.usage_reset_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapRubric(row: Record<string, unknown>): RubricRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      description: String(row.description ?? ''),
      isDefault: Boolean(row.is_default),
      isActive: Boolean(row.is_active),
      passScoreThreshold: Number(row.pass_score_threshold ?? 75),
      criteria: JSON.parse(String(row.criteria_json)),
      piiConfig: JSON.parse(String(row.pii_config_json)),
      autoTagConfig: JSON.parse(String(row.auto_tag_config_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapEvaluation(row: Record<string, unknown>): EvaluationRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      ticketId: String(row.ticket_id),
      ticketSubject: String(row.ticket_subject ?? ''),
      assigneeName: String(row.assignee_name ?? 'Unassigned'),
      rubricId: String(row.rubric_id),
      rubricName: String(row.rubric_name),
      overallScore: Number(row.overall_score),
      passed: Boolean(row.passed),
      hasCriticalFail: Boolean(row.has_critical_fail),
      coachingPriority: row.coaching_priority as ComputedEvaluation['coachingPriority'],
      piiDetected: Boolean(row.pii_detected),
      piiSeverity: row.pii_severity as ComputedEvaluation['piiSeverity'],
      criteriaResults: JSON.parse(String(row.criteria_results_json)),
      piiResults: JSON.parse(String(row.pii_results_json)),
      modelUsed: String(row.model_used),
      inputTokens: Number(row.input_tokens ?? 0),
      latencyMs: Number(row.latency_ms ?? 0),
      attachmentCount: Number(row.attachment_count ?? 0),
      evaluatedAt: String(row.evaluated_at),
    };
  }

  private mapPiiFinding(row: Record<string, unknown>): PiiFindingRecord {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      evaluationId: String(row.evaluation_id),
      ticketId: String(row.ticket_id),
      commentId: String(row.comment_id),
      attachmentId: String(row.attachment_id),
      attachmentFilename: String(row.attachment_filename),
      attachmentUrl: String(row.attachment_url),
      piiCategories: JSON.parse(String(row.pii_categories_json)),
      maxProbability: Number(row.max_probability),
      confidence: Number(row.confidence),
      status: row.status as PiiFindingRecord['status'],
      redactedBy: row.redacted_by ? String(row.redacted_by) : null,
      redactedAt: row.redacted_at ? String(row.redacted_at) : null,
      createdAt: String(row.created_at),
    };
  }

  async getOrCreateTenant(subdomain: string): Promise<TenantRecord> {
    const clean = subdomain.trim().toLowerCase();
    const existing = await this.getTenantBySubdomain(clean);
    if (existing) return existing;

    const id = `ten_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const resetAt = nextMonthResetIso();

    this.db
      .prepare(
        `INSERT INTO tenants (id, zendesk_subdomain, plan_tier, monthly_ticket_count, usage_reset_at, created_at, updated_at)
         VALUES (?, ?, 'free', 0, ?, ?, ?)`,
      )
      .run(id, clean, resetAt, now, now);

    // Seed default SaaS QA & PII Guardrail rubric
    await this.createRubric(id, DEFAULT_SAAS_RUBRIC);

    const created = await this.getTenantById(id);
    if (!created) throw new Error('Failed to create tenant');
    return created;
  }

  async getTenantBySubdomain(subdomain: string): Promise<TenantRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM tenants WHERE zendesk_subdomain = ?')
      .get(subdomain.trim().toLowerCase()) as Record<string, unknown> | undefined;
    return row ? this.mapTenant(row) : null;
  }

  async getTenantById(tenantId: string): Promise<TenantRecord | null> {
    const row = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapTenant(row) : null;
  }

  async updateTenantOAuth(
    tenantId: string,
    patch: {
      accessTokenEnc: string;
      refreshTokenEnc: string | null;
      expiresAt: string;
      zendeskAccountId?: string | null;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tenants
         SET oauth_access_token_enc = ?,
             oauth_refresh_token_enc = COALESCE(?, oauth_refresh_token_enc),
             oauth_expires_at = ?,
             zendesk_account_id = COALESCE(?, zendesk_account_id),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.accessTokenEnc,
        patch.refreshTokenEnc,
        patch.expiresAt,
        patch.zendeskAccountId ?? null,
        now,
        tenantId,
      );
  }

  async updateTenantWebhook(
    tenantId: string,
    webhookId: string,
    webhookSecretEnc: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tenants SET webhook_id = ?, webhook_secret_enc = ?, updated_at = ? WHERE id = ?`,
      )
      .run(webhookId, webhookSecretEnc, now, tenantId);
  }

  async updateTenantBilling(
    subdomain: string,
    patch: {
      planTier: PlanTier;
      paddleCustomerId?: string | null;
      paddleSubscriptionId?: string | null;
      paddleStatus?: string | null;
    },
  ): Promise<TenantRecord> {
    const tenant = await this.getOrCreateTenant(subdomain);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tenants
         SET plan_tier = ?,
             paddle_customer_id = COALESCE(?, paddle_customer_id),
             paddle_subscription_id = COALESCE(?, paddle_subscription_id),
             paddle_status = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.planTier,
        patch.paddleCustomerId ?? null,
        patch.paddleSubscriptionId ?? null,
        patch.paddleStatus ?? null,
        now,
        tenant.id,
      );
    return (await this.getTenantById(tenant.id))!;
  }

  async consumeTicketQuota(
    tenantId: string,
  ): Promise<{ allowed: boolean; used: number; limit: number }> {
    const tenant = await this.getTenantById(tenantId);
    if (!tenant) throw new Error('Tenant not found');

    const now = new Date();
    let count = tenant.monthlyTicketCount;
    if (now.toISOString() >= tenant.usageResetAt) {
      count = 0;
      this.db
        .prepare(
          `UPDATE tenants SET monthly_ticket_count = 0, usage_reset_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(nextMonthResetIso(now), now.toISOString(), tenantId);
    }

    const limit = PLAN_CATALOG[tenant.planTier].monthlyTicketLimit;
    if (count >= limit) {
      return { allowed: false, used: count, limit };
    }

    const nextCount = count + 1;
    this.db
      .prepare(`UPDATE tenants SET monthly_ticket_count = ?, updated_at = ? WHERE id = ?`)
      .run(nextCount, now.toISOString(), tenantId);

    return { allowed: true, used: nextCount, limit };
  }

  async listRubrics(tenantId: string): Promise<RubricRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM rubrics WHERE tenant_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at ASC`,
      )
      .all(tenantId) as Record<string, unknown>[];
    return rows.map((r) => this.mapRubric(r));
  }

  async getRubricById(tenantId: string, rubricId: string): Promise<RubricRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM rubrics WHERE tenant_id = ? AND id = ? AND is_active = 1`)
      .get(tenantId, rubricId) as Record<string, unknown> | undefined;
    return row ? this.mapRubric(row) : null;
  }

  async getDefaultRubric(tenantId: string): Promise<RubricRecord> {
    const rows = await this.listRubrics(tenantId);
    const def = rows.find((r) => r.isDefault) ?? rows[0];
    if (def) return def;
    return this.createRubric(tenantId, DEFAULT_SAAS_RUBRIC);
  }

  async createRubric(tenantId: string, input: RubricInput): Promise<RubricRecord> {
    const id = `rub_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const now = new Date().toISOString();
    if (input.isDefault) {
      this.db.prepare(`UPDATE rubrics SET is_default = 0 WHERE tenant_id = ?`).run(tenantId);
    }
    this.db
      .prepare(
        `INSERT INTO rubrics
          (id, tenant_id, name, description, is_default, is_active, pass_score_threshold, criteria_json, pii_config_json, auto_tag_config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tenantId,
        input.name,
        input.description,
        input.isDefault ? 1 : 0,
        input.passScoreThreshold,
        JSON.stringify(input.criteria),
        JSON.stringify(input.piiConfig),
        JSON.stringify(input.autoTagConfig),
        now,
        now,
      );
    return (await this.getRubricById(tenantId, id))!;
  }

  async updateRubric(
    tenantId: string,
    rubricId: string,
    input: RubricInput,
  ): Promise<RubricRecord | null> {
    const existing = await this.getRubricById(tenantId, rubricId);
    if (!existing) return null;
    if (input.isDefault) {
      this.db.prepare(`UPDATE rubrics SET is_default = 0 WHERE tenant_id = ?`).run(tenantId);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE rubrics
         SET name = ?, description = ?, is_default = ?, pass_score_threshold = ?,
             criteria_json = ?, pii_config_json = ?, auto_tag_config_json = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(
        input.name,
        input.description,
        input.isDefault ? 1 : 0,
        input.passScoreThreshold,
        JSON.stringify(input.criteria),
        JSON.stringify(input.piiConfig),
        JSON.stringify(input.autoTagConfig),
        now,
        tenantId,
        rubricId,
      );
    return this.getRubricById(tenantId, rubricId);
  }

  async deleteRubric(tenantId: string, rubricId: string): Promise<boolean> {
    const rubrics = await this.listRubrics(tenantId);
    if (rubrics.length <= 1) return false;
    const res = this.db
      .prepare(`UPDATE rubrics SET is_active = 0, is_default = 0 WHERE tenant_id = ? AND id = ?`)
      .run(tenantId, rubricId);
    const remaining = await this.listRubrics(tenantId);
    if (remaining.length > 0 && !remaining.some((r) => r.isDefault)) {
      this.db.prepare(`UPDATE rubrics SET is_default = 1 WHERE id = ?`).run(remaining[0].id);
    }
    return Number(res.changes) > 0;
  }

  async saveEvaluation(
    record: Omit<EvaluationRecord, 'id' | 'evaluatedAt'>,
  ): Promise<EvaluationRecord> {
    const id = `evl_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const evaluatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO evaluations
          (id, tenant_id, ticket_id, ticket_subject, assignee_name, rubric_id, rubric_name,
           overall_score, passed, has_critical_fail, coaching_priority, pii_detected, pii_severity,
           criteria_results_json, pii_results_json, model_used, input_tokens, latency_ms, attachment_count, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.tenantId,
        record.ticketId,
        record.ticketSubject,
        record.assigneeName,
        record.rubricId,
        record.rubricName,
        record.overallScore,
        record.passed ? 1 : 0,
        record.hasCriticalFail ? 1 : 0,
        record.coachingPriority,
        record.piiDetected ? 1 : 0,
        record.piiSeverity,
        JSON.stringify(record.criteriaResults),
        JSON.stringify(record.piiResults),
        record.modelUsed,
        record.inputTokens,
        record.latencyMs,
        record.attachmentCount,
        evaluatedAt,
      );
    return { ...record, id, evaluatedAt };
  }

  async getLatestEvaluationForTicket(
    tenantId: string,
    ticketId: string,
  ): Promise<EvaluationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM evaluations WHERE tenant_id = ? AND ticket_id = ? ORDER BY evaluated_at DESC LIMIT 1`,
      )
      .get(tenantId, ticketId) as Record<string, unknown> | undefined;
    return row ? this.mapEvaluation(row) : null;
  }

  async listEvaluations(tenantId: string, limit = 50): Promise<EvaluationRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM evaluations WHERE tenant_id = ? ORDER BY evaluated_at DESC LIMIT ?`)
      .all(tenantId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapEvaluation(r));
  }

  async upsertPiiFinding(
    finding: Omit<PiiFindingRecord, 'id' | 'createdAt' | 'redactedBy' | 'redactedAt'>,
  ): Promise<PiiFindingRecord> {
    const existing = this.db
      .prepare(
        `SELECT * FROM pii_findings WHERE tenant_id = ? AND ticket_id = ? AND attachment_id = ?`,
      )
      .get(finding.tenantId, finding.ticketId, finding.attachmentId) as
      | Record<string, unknown>
      | undefined;

    if (existing) {
      const mapped = this.mapPiiFinding(existing);
      const nextStatus = mapped.status === 'redacted' ? 'redacted' : finding.status;
      this.db
        .prepare(
          `UPDATE pii_findings
           SET evaluation_id = ?, pii_categories_json = ?, max_probability = ?, confidence = ?, status = ?
           WHERE id = ?`,
        )
        .run(
          finding.evaluationId,
          JSON.stringify(finding.piiCategories),
          finding.maxProbability,
          finding.confidence,
          nextStatus,
          mapped.id,
        );
      return (await this.getPiiFindingById(finding.tenantId, mapped.id))!;
    }

    const id = `pii_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pii_findings
          (id, tenant_id, evaluation_id, ticket_id, comment_id, attachment_id, attachment_filename,
           attachment_url, pii_categories_json, max_probability, confidence, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        finding.tenantId,
        finding.evaluationId,
        finding.ticketId,
        finding.commentId,
        finding.attachmentId,
        finding.attachmentFilename,
        finding.attachmentUrl,
        JSON.stringify(finding.piiCategories),
        finding.maxProbability,
        finding.confidence,
        finding.status,
        createdAt,
      );
    return (await this.getPiiFindingById(finding.tenantId, id))!;
  }

  async listPiiFindingsForTicket(tenantId: string, ticketId: string): Promise<PiiFindingRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM pii_findings WHERE tenant_id = ? AND ticket_id = ? ORDER BY created_at DESC`,
      )
      .all(tenantId, ticketId) as Record<string, unknown>[];
    return rows.map((r) => this.mapPiiFinding(r));
  }

  async listPiiFindings(
    tenantId: string,
    status?: PiiFindingRecord['status'],
    limit = 50,
  ): Promise<PiiFindingRecord[]> {
    const rows = status
      ? (this.db
          .prepare(
            `SELECT * FROM pii_findings WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(tenantId, status, limit) as Record<string, unknown>[])
      : (this.db
          .prepare(
            `SELECT * FROM pii_findings WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(tenantId, limit) as Record<string, unknown>[]);
    return rows.map((r) => this.mapPiiFinding(r));
  }

  async getPiiFindingById(tenantId: string, findingId: string): Promise<PiiFindingRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM pii_findings WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, findingId) as Record<string, unknown> | undefined;
    return row ? this.mapPiiFinding(row) : null;
  }

  async markPiiFindingStatus(
    tenantId: string,
    findingId: string,
    status: 'redacted' | 'dismissed',
    actor: string,
  ): Promise<PiiFindingRecord | null> {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE pii_findings SET status = ?, redacted_by = ?, redacted_at = ? WHERE tenant_id = ? AND id = ?`,
      )
      .run(status, actor, now, tenantId, findingId);
    if (Number(res.changes) === 0) return null;
    return this.getPiiFindingById(tenantId, findingId);
  }

  async markPiiFindingRedactedByAttachment(
    tenantId: string,
    ticketId: string,
    attachmentId: string,
    actor: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE pii_findings SET status = 'redacted', redacted_by = ?, redacted_at = ?
         WHERE tenant_id = ? AND ticket_id = ? AND attachment_id = ?`,
      )
      .run(actor, now, tenantId, ticketId, attachmentId);
  }

  async recordBillingEventIfNew(eventId: string, eventType: string): Promise<boolean> {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO billing_events (event_id, event_type, processed_at) VALUES (?, ?, ?)`,
      )
      .run(eventId, eventType, now);
    return Number(res.changes) > 0;
  }

  async getDashboardOverview(tenantId: string): Promise<DashboardOverview> {
    const tenant = await this.getTenantById(tenantId);
    if (!tenant) throw new Error('Tenant not found');
    const recentEvaluations = await this.listEvaluations(tenantId, 25);
    const openPiiFindings = await this.listPiiFindings(tenantId, 'flagged', 30);

    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(AVG(overall_score), 0) AS avg_score,
                COALESCE(AVG(passed), 0) AS pass_rate,
                COALESCE(AVG(latency_ms), 0) AS avg_latency
         FROM evaluations WHERE tenant_id = ?`,
      )
      .get(tenantId) as Record<string, unknown>;

    const redactedRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM pii_findings WHERE tenant_id = ? AND status = 'redacted'`,
      )
      .get(tenantId) as Record<string, unknown>;

    return {
      tenant: {
        zendeskSubdomain: tenant.zendeskSubdomain,
        oauthConnected: tenant.oauthConnected,
        webhookActive: Boolean(tenant.webhookId),
        planTier: tenant.planTier,
        paddleStatus: tenant.paddleStatus,
        monthlyTicketCount: tenant.monthlyTicketCount,
        monthlyTicketLimit: PLAN_CATALOG[tenant.planTier].monthlyTicketLimit,
        usageResetAt: tenant.usageResetAt,
        hasPaddleCustomer: Boolean(tenant.paddleCustomerId),
      },
      metrics: {
        totalEvaluated: Number(agg.total ?? 0),
        averageScore: Math.round(Number(agg.avg_score ?? 0)),
        passRate: Math.round(Number(agg.pass_rate ?? 0) * 100),
        activePiiAlerts: openPiiFindings.length,
        redactedCount: Number(redactedRow.cnt ?? 0),
        avgLatencyMs: Math.round(Number(agg.avg_latency ?? 0)),
      },
      recentEvaluations,
      openPiiFindings,
    };
  }

  close(): void {
    this.db.close();
  }
}
