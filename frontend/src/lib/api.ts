import type {
  ComputedEvaluation,
  PiiCategory,
  PlanDefinition,
  PlanTier,
  RubricInput,
  RubricRecord,
} from '@rubriccheck/shared';

export interface EvaluationDTO {
  id: string;
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

export interface PiiFindingDTO {
  id: string;
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

export interface OverviewDTO {
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
  recentEvaluations: EvaluationDTO[];
  openPiiFindings: PiiFindingDTO[];
}

export interface BillingConfigDTO {
  environment: 'sandbox' | 'production';
  clientToken: string;
  subdomain: string;
  currentTier: PlanTier;
  paddleStatus: string | null;
  hasPortalAccess: boolean;
  prices: {
    starter: { monthly: string; annual: string };
    growth: { monthly: string; annual: string };
    scale: { monthly: string; annual: string };
  };
  plans: Record<PlanTier, PlanDefinition>;
}

export class ApiClient {
  constructor(private token: string) {}

  setToken(token: string) {
    this.token = token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errBody.error || `Request failed (${res.status})`);
    }
    return (await res.json()) as T;
  }

  static async bootstrapDevSession(subdomain = 'acme-support'): Promise<{
    token: string;
    subdomain: string;
    planTier: PlanTier;
  }> {
    const res = await fetch('/api/session/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subdomain }),
    });
    if (!res.ok) {
      throw new Error('Unable to initialize session');
    }
    return (await res.json()) as { token: string; subdomain: string; planTier: PlanTier };
  }

  getOverview() {
    return this.request<OverviewDTO>('/api/dashboard/overview');
  }

  getTicketEvaluation(ticketId: string) {
    return this.request<{
      evaluation: EvaluationDTO | null;
      piiFindings: PiiFindingDTO[];
      quota: { used: number; limit: number; planTier: PlanTier };
    }>(`/api/tickets/${encodeURIComponent(ticketId)}/evaluation`);
  }

  evaluateTicket(ticketId: string, rubricId?: string) {
    return this.request<{
      evaluation: EvaluationDTO;
      piiFindings: PiiFindingDTO[];
      quota: { used: number; limit: number };
    }>(`/api/tickets/${encodeURIComponent(ticketId)}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({ rubricId }),
    });
  }

  simulateTicket(payload: {
    ticketId: string;
    subject: string;
    assigneeName: string;
    transcriptText: string;
    rubricId?: string;
    attachments: Array<{
      attachmentId: string;
      commentId: string;
      filename: string;
      mimeType: string;
      base64Data?: string;
    }>;
  }) {
    return this.request<{
      evaluation: EvaluationDTO;
      piiFindings: PiiFindingDTO[];
      quota: { used: number; limit: number };
    }>('/api/tickets/simulate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  redactFinding(findingId: string) {
    return this.request<{ finding: PiiFindingDTO }>(`/api/pii/${encodeURIComponent(findingId)}/redact`, {
      method: 'POST',
    });
  }

  dismissFinding(findingId: string) {
    return this.request<{ finding: PiiFindingDTO }>(
      `/api/pii/${encodeURIComponent(findingId)}/dismiss`,
      { method: 'POST' },
    );
  }

  listRubrics() {
    return this.request<{ rubrics: RubricRecord[]; limits: PlanDefinition }>('/api/rubrics');
  }

  listTemplates() {
    return this.request<{ templates: RubricInput[] }>('/api/rubrics/templates');
  }

  createRubric(input: RubricInput) {
    return this.request<{ rubric: RubricRecord }>('/api/rubrics', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  updateRubric(id: string, input: RubricInput) {
    return this.request<{ rubric: RubricRecord }>(`/api/rubrics/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  deleteRubric(id: string) {
    return this.request<{ deleted: boolean }>(`/api/rubrics/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  getBillingConfig() {
    return this.request<BillingConfigDTO>('/api/billing/config');
  }

  createPortalSession() {
    return this.request<{ url: string }>('/api/billing/portal', { method: 'POST' });
  }

  async downloadCsv(): Promise<string> {
    const res = await fetch('/api/dashboard/export.csv', {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || 'CSV export failed');
    }
    return res.text();
  }
}
