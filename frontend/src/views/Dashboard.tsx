import React, { useEffect, useState } from 'react';
import {
  PII_CATEGORY_META,
  PLAN_CATALOG,
  type PiiCategory,
  type PlanTier,
  type RubricCriterion,
  type RubricInput,
  type RubricRecord,
} from '@rubriccheck/shared';
import type { ApiClient, BillingConfigDTO, OverviewDTO } from '../lib/api';
import {
  BrandMark,
  CheckIcon,
  ExternalIcon,
  LockIcon,
  RefreshIcon,
  ShieldAlertIcon,
  TrashIcon,
} from '../components/Icons';

type DashTab = 'overview' | 'rubrics' | 'tester' | 'billing';

interface Props {
  api: ApiClient;
  onInspectTicket: (ticketId: string) => void;
  onNotify: (msg: string) => void;
}

export function Dashboard({ api, onInspectTicket, onNotify }: Props) {
  const [tab, setTab] = useState<DashTab>('overview');
  const [overview, setOverview] = useState<OverviewDTO | null>(null);
  const [rubrics, setRubrics] = useState<RubricRecord[]>([]);
  const [templates, setTemplates] = useState<RubricInput[]>([]);
  const [billing, setBilling] = useState<BillingConfigDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Rubric Editor state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RubricInput | null>(null);
  const [savingRubric, setSavingRubric] = useState(false);
  const [showAutoRedactConfirm, setShowAutoRedactConfirm] = useState(false);
  const [ackIrreversibleChecked, setAckIrreversibleChecked] = useState(false);

  // Billing state
  const [annualBilling, setAnnualBilling] = useState(true);
  const [zdSubdomainInput, setZdSubdomainInput] = useState('');

  // Live Multimodal Tester state
  const [simTicketId, setSimTicketId] = useState('10499');
  const [simSubject, setSimSubject] = useState('Billing dispute — card photo attached');
  const [simAssignee, setSimAssignee] = useState('Noa Tal');
  const [simTranscript, setSimTranscript] = useState(
    'Customer: Hi support, I noticed two charges of $79 on my Visa card 4532-1190-8821-4242. I attached a photo of the card and statement.\nAgent: Hi Alex, thank you for alerting us. I confirmed the duplicate charge on invoice #8821 and issued a full refund today (arrives in 3-5 business days). For your safety, we will redact your card image right away.',
  );
  const [simFile, setSimFile] = useState<{
    filename: string;
    mimeType: string;
    base64Data?: string;
  } | null>({
    filename: 'visa_credit_card_photo.png',
    mimeType: 'image/png',
  });
  const [simRunning, setSimRunning] = useState(false);

  async function refreshAll() {
    setLoading(true);
    setError(null);
    try {
      const [ov, rubRes, tplRes, billRes] = await Promise.all([
        api.getOverview(),
        api.listRubrics(),
        api.listTemplates(),
        api.getBillingConfig(),
      ]);
      setOverview(ov);
      setRubrics(rubRes.rubrics);
      setTemplates(tplRes.templates);
      setBilling(billRes);
      setZdSubdomainInput((prev) => prev || ov.tenant.zendeskSubdomain);
      if (rubRes.rubrics.length > 0 && !draft) {
        const active = rubRes.rubrics[0];
        setEditingId(active.id);
        setDraft({
          name: active.name,
          description: active.description,
          isDefault: active.isDefault,
          passScoreThreshold: active.passScoreThreshold,
          criteria: active.criteria,
          piiConfig: active.piiConfig,
          autoTagConfig: active.autoTagConfig,
        });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll();
  }, []);

  async function handleRedactFromQueue(findingId: string) {
    try {
      const res = await api.redactFinding(findingId);
      onNotify(`Redacted "${res.finding.attachmentFilename}" on ticket #${res.finding.ticketId}`);
      await refreshAll();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleExportCsv() {
    try {
      const csv = await api.downloadCsv();
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rubriccheck-${overview?.tenant.zendeskSubdomain || 'export'}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      onNotify('CSV report downloaded');
    } catch (err) {
      onNotify((err as Error).message);
    }
  }

  async function handleSaveRubric() {
    if (!draft) return;
    setSavingRubric(true);
    setError(null);
    try {
      if (editingId) {
        await api.updateRubric(editingId, draft);
        onNotify(`Saved rubric "${draft.name}"`);
      } else {
        const created = await api.createRubric(draft);
        setEditingId(created.rubric.id);
        onNotify(`Created rubric "${draft.name}"`);
      }
      await refreshAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingRubric(false);
    }
  }

  async function handleDeleteRubric(id: string) {
    try {
      await api.deleteRubric(id);
      setEditingId(null);
      setDraft(null);
      onNotify('Rubric deleted');
      await refreshAll();
    } catch (err) {
      onNotify((err as Error).message);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
      setSimFile({
        filename: file.name,
        mimeType: file.type || 'image/png',
        base64Data: base64,
      });
    };
    reader.readAsDataURL(file);
  }

  async function handleRunSimulation() {
    setSimRunning(true);
    setError(null);
    try {
      const res = await api.simulateTicket({
        ticketId: simTicketId,
        subject: simSubject,
        assigneeName: simAssignee,
        transcriptText: simTranscript,
        attachments: simFile
          ? [
              {
                attachmentId: `att_${Date.now()}`,
                commentId: `cmt_${Date.now()}`,
                filename: simFile.filename,
                mimeType: simFile.mimeType,
                base64Data: simFile.base64Data,
              },
            ]
          : [],
      });
      await refreshAll();
      onNotify(
        `Scanned #${simTicketId}: QA ${res.evaluation.overallScore}/100 · PII ${res.evaluation.piiDetected ? res.evaluation.piiSeverity.toUpperCase() : 'Clean'} (${res.evaluation.latencyMs}ms)`,
      );
      onInspectTicket(simTicketId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSimRunning(false);
    }
  }

  function openPaddleCheckout(tier: 'starter' | 'growth' | 'scale') {
    if (!billing) return;
    const priceId = annualBilling ? billing.prices[tier].annual : billing.prices[tier].monthly;
    if (!billing.clientToken) {
      onNotify('Paddle client token is not configured in environment.');
      return;
    }
    if (!window.Paddle) {
      onNotify('Paddle.js script did not load. Check network/CSP settings.');
      return;
    }
    if (billing.environment === 'sandbox' && window.Paddle.Environment) {
      window.Paddle.Environment.set('sandbox');
    }
    window.Paddle.Initialize({ token: billing.clientToken });
    window.Paddle.Checkout.open({
      items: [{ priceId, quantity: 1 }],
      customData: {
        app: 'rubriccheck-qa',
        zendesk_subdomain: billing.subdomain,
        tier,
      },
      settings: { displayMode: 'overlay', theme: 'light', locale: 'en' },
    });
  }

  async function openCustomerPortal() {
    try {
      const { url } = await api.createPortalSession();
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      onNotify((err as Error).message);
    }
  }

  function addCriterion(kind: 'score' | 'noul') {
    if (!draft) return;
    const id = `crit_${Date.now().toString(36)}`;
    const next: RubricCriterion =
      kind === 'score'
        ? {
            id,
            kind: 'score',
            label: 'New Rubric Criterion',
            instructions: 'Rate the agent response quality on this dimension.',
            weight: 15,
            levels: ['Poor', 'Below standard', 'Acceptable', 'Strong', 'Exceptional'],
          }
        : {
            id,
            kind: 'noul',
            label: 'New Compliance Check',
            instructions: 'Did the agent follow the required verification policy?',
            weight: 10,
            trueDescription: 'Policy followed properly.',
            falseDescription: 'Policy missed or violated.',
            passThreshold: 0.65,
            criticalFail: false,
          };
    setDraft({ ...draft, criteria: [...draft.criteria, next] });
  }

  const currentPlanDef = overview ? PLAN_CATALOG[overview.tenant.planTier] : PLAN_CATALOG.free;

  return (
    <div className="dash-shell">
      <header className="dash-topbar">
        <div className="brand-lockup">
          <BrandMark size={26} />
          <div>
            <div className="brand-name" style={{ fontSize: 15 }}>
              RubricCheck QA
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--rc-ink-muted)' }}>
              {overview ? `${overview.tenant.zendeskSubdomain}.zendesk.com` : 'Loading workspace…'}
            </div>
          </div>
        </div>

        <nav className="dash-nav" aria-label="Dashboard sections">
          {(
            [
              ['overview', 'Overview'],
              ['rubrics', 'Rubrics'],
              ['tester', 'PII Tester'],
              ['billing', 'Billing & OAuth'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`dash-tab ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
              {id === 'overview' && overview && overview.metrics.activePiiAlerts > 0 && (
                <span className="tag tag-danger mono" style={{ marginLeft: 6, padding: '0 6px' }}>
                  {overview.metrics.activePiiAlerts}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`tag ${overview?.tenant.oauthConnected ? 'tag-pass' : 'tag-neutral'}`}>
            {overview?.tenant.oauthConnected ? 'Zendesk OAuth Active' : 'Sandbox Preview'}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void refreshAll()}
          >
            <RefreshIcon size={13} />
            Refresh
          </button>
        </div>
      </header>

      <main className="dash-main">
        {error && (
          <div
            className="panel"
            style={{
              background: 'var(--rc-danger-soft)',
              borderColor: 'var(--rc-danger-border)',
              color: 'var(--rc-danger)',
              padding: '12px 16px',
            }}
          >
            {error}
          </div>
        )}

        {loading && !overview ? (
          <div className="panel">
            <div className="panel-body">Loading QA metrics and rubrics…</div>
          </div>
        ) : (
          overview && (
            <>
              {tab === 'overview' && (
                <>
                  <section className="kpi-strip" aria-label="Quality and compliance summary">
                    <div className="kpi-cell">
                      <div className="kpi-label">Average QA score</div>
                      <div className="kpi-value mono">
                        {overview.metrics.averageScore}
                        <span style={{ fontSize: 15, color: 'var(--rc-ink-muted)' }}>/100</span>
                      </div>
                      <div className="kpi-sub">
                        {overview.metrics.totalEvaluated} tickets evaluated
                      </div>
                    </div>
                    <div className="kpi-cell">
                      <div className="kpi-label">Pass rate</div>
                      <div className="kpi-value mono">{overview.metrics.passRate}%</div>
                      <div className="kpi-sub">Weighted rubric threshold</div>
                    </div>
                    <div className="kpi-cell">
                      <div className="kpi-label">Open PII alerts</div>
                      <div
                        className="kpi-value mono"
                        style={{
                          color:
                            overview.metrics.activePiiAlerts > 0
                              ? 'var(--rc-danger)'
                              : 'var(--rc-forest)',
                        }}
                      >
                        {overview.metrics.activePiiAlerts}
                      </div>
                      <div className="kpi-sub">Screenshots &amp; PDFs flagged</div>
                    </div>
                    <div className="kpi-cell">
                      <div className="kpi-label">Attachments redacted</div>
                      <div className="kpi-value mono">{overview.metrics.redactedCount}</div>
                      <div className="kpi-sub">Scrubbed via Zendesk API</div>
                    </div>
                    <div className="kpi-cell">
                      <div className="kpi-label">Monthly quota ({currentPlanDef.name})</div>
                      <div className="kpi-value mono">
                        {overview.tenant.monthlyTicketCount}
                        <span style={{ fontSize: 14, color: 'var(--rc-ink-muted)' }}>
                          /{overview.tenant.monthlyTicketLimit.toLocaleString()}
                        </span>
                      </div>
                      <div className="kpi-sub">Unlimited agents · Flat rate</div>
                    </div>
                  </section>

                  {/* Open PII Queue */}
                  <section className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <ShieldAlertIcon size={17} />
                        Open Screenshot &amp; PDF PII Exposure Queue
                      </h2>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setTab('tester')}
                      >
                        Test multimodal PII scan
                      </button>
                    </div>
                    {overview.openPiiFindings.length === 0 ? (
                      <div className="panel-body" style={{ color: 'var(--rc-ink-secondary)' }}>
                        No exposed PII attachments currently waiting for action. Any newly uploaded
                        screenshot or PDF with credit cards, IDs, or API keys appears here in ~200ms.
                      </div>
                    ) : (
                      <div className="table-wrap">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Ticket</th>
                              <th>Attachment</th>
                              <th>Detected PII</th>
                              <th>Confidence</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overview.openPiiFindings.map((f) => (
                              <tr key={f.id}>
                                <td className="mono">
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm mono"
                                    onClick={() => onInspectTicket(f.ticketId)}
                                  >
                                    #{f.ticketId}
                                  </button>
                                </td>
                                <td className="mono">{f.attachmentFilename}</td>
                                <td>
                                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                    {f.piiCategories.map((c) => (
                                      <span key={c} className="tag tag-danger">
                                        {PII_CATEGORY_META[c]?.label ?? c}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                                <td className="mono">
                                  {Math.round(f.maxProbability * 100)}% (conf{' '}
                                  {Math.round(f.confidence * 100)}%)
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    className="btn btn-danger btn-sm"
                                    onClick={() => void handleRedactFromQueue(f.id)}
                                  >
                                    Redact attachment
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>

                  {/* Recent Evaluations Table */}
                  <section className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title">Recent Automated QA Evaluations</h2>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void handleExportCsv()}
                        >
                          Export CSV {!currentPlanDef.csvExport && '(Growth+)'}
                        </button>
                      </div>
                    </div>
                    {overview.recentEvaluations.length === 0 ? (
                      <div className="panel-body" style={{ color: 'var(--rc-ink-secondary)' }}>
                        No evaluated tickets yet. Open the <strong>Multimodal Tester</strong> tab or
                        connect Zendesk OAuth to evaluate live tickets automatically.
                      </div>
                    ) : (
                      <div className="table-wrap">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Ticket</th>
                              <th>Subject</th>
                              <th>Assignee</th>
                              <th>Score</th>
                              <th>QA Status</th>
                              <th>PII Guardrail</th>
                              <th>Latency</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overview.recentEvaluations.map((ev) => (
                              <tr key={ev.id}>
                                <td className="mono">
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm mono"
                                    onClick={() => onInspectTicket(ev.ticketId)}
                                  >
                                    #{ev.ticketId}
                                  </button>
                                </td>
                                <td style={{ maxWidth: 260 }}>{ev.ticketSubject}</td>
                                <td>{ev.assigneeName}</td>
                                <td className="mono" style={{ fontWeight: 700 }}>
                                  {ev.overallScore}/100
                                </td>
                                <td>
                                  <span className={`tag ${ev.passed ? 'tag-pass' : 'tag-warn'}`}>
                                    {ev.passed ? 'Pass' : 'Review'}
                                  </span>
                                </td>
                                <td>
                                  {ev.piiDetected ? (
                                    <span className="tag tag-danger">
                                      PII ({ev.piiSeverity})
                                    </span>
                                  ) : (
                                    <span className="tag tag-neutral">Clean</span>
                                  )}
                                </td>
                                <td className="mono">{ev.latencyMs}ms</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                </>
              )}

              {tab === 'rubrics' && draft && (
                <section className="panel">
                  <div className="panel-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <h2 className="panel-title">Rubric &amp; PII Policy Builder</h2>
                      <select
                        className="select"
                        style={{ width: 'auto', minWidth: 220 }}
                        aria-label="Select rubric"
                        value={editingId ?? '__new__'}
                        onChange={(e) => {
                          const selected = rubrics.find((r) => r.id === e.target.value);
                          if (selected) {
                            setEditingId(selected.id);
                            setDraft({
                              name: selected.name,
                              description: selected.description,
                              isDefault: selected.isDefault,
                              passScoreThreshold: selected.passScoreThreshold,
                              criteria: selected.criteria,
                              piiConfig: selected.piiConfig,
                              autoTagConfig: selected.autoTagConfig,
                            });
                          }
                        }}
                      >
                        {rubrics.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name} {r.isDefault ? '(Default)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {templates.map((tpl) => (
                        <button
                          key={tpl.name}
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setEditingId(null);
                            setDraft({ ...tpl, isDefault: false });
                            onNotify(`Loaded template "${tpl.name}" — click Save changes to add`);
                          }}
                        >
                          + {tpl.name.split(' ')[0]} Template
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="panel-body">
                    <div className="field-grid" style={{ marginBottom: 18 }}>
                      <div className="field">
                        <label htmlFor="rubric-name">Rubric name</label>
                        <input
                          id="rubric-name"
                          className="input"
                          value={draft.name}
                          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="rubric-threshold">Pass threshold (0–100)</label>
                        <input
                          id="rubric-threshold"
                          type="number"
                          min={0}
                          max={100}
                          className="input mono"
                          value={draft.passScoreThreshold}
                          onChange={(e) =>
                            setDraft({ ...draft, passScoreThreshold: Number(e.target.value) })
                          }
                        />
                      </div>
                    </div>

                    <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700 }}>
                      QA Scoring Criteria ({draft.criteria.length} /{' '}
                      {currentPlanDef.maxCriteriaPerRubric})
                    </h3>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
                      {draft.criteria.map((c, idx) => (
                        <div
                          key={c.id}
                          style={{
                            border: '1px solid var(--rc-border)',
                            borderRadius: 6,
                            padding: 12,
                            background: 'var(--rc-bg)',
                          }}
                        >
                          <div className="field-grid" style={{ marginBottom: 8 }}>
                            <div className="field">
                              <label>Label ({c.kind === 'score' ? '0–4 Scale' : 'Yes/No Noul'})</label>
                              <input
                                className="input"
                                value={c.label}
                                onChange={(e) => {
                                  const next = [...draft.criteria];
                                  next[idx] = { ...c, label: e.target.value };
                                  setDraft({ ...draft, criteria: next });
                                }}
                              />
                            </div>
                            <div className="field">
                              <label>Weight</label>
                              <div style={{ display: 'flex', gap: 8 }}>
                                <input
                                  type="number"
                                  min={1}
                                  max={100}
                                  className="input mono"
                                  value={c.weight}
                                  onChange={(e) => {
                                    const next = [...draft.criteria];
                                    next[idx] = { ...c, weight: Number(e.target.value) };
                                    setDraft({ ...draft, criteria: next });
                                  }}
                                />
                                {draft.criteria.length > 1 && (
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    aria-label={`Remove ${c.label}`}
                                    onClick={() =>
                                      setDraft({
                                        ...draft,
                                        criteria: draft.criteria.filter((_, i) => i !== idx),
                                      })
                                    }
                                  >
                                    <TrashIcon size={14} />
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="field">
                            <label>Evaluation instruction (evaluated by gemini-decision-1)</label>
                            <textarea
                              className="textarea"
                              value={c.instructions}
                              onChange={(e) => {
                                const next = [...draft.criteria];
                                next[idx] = { ...c, instructions: e.target.value };
                                setDraft({ ...draft, criteria: next });
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div style={{ display: 'flex', gap: 8, marginBottom: 22, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => addCriterion('score')}
                      >
                        + Add score criterion
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => addCriterion('noul')}
                      >
                        + Add Yes/No compliance check
                      </button>
                    </div>

                    {/* PII Guardrail Settings */}
                    <div
                      style={{
                        borderTop: '1px solid var(--rc-border)',
                        paddingTop: 18,
                        marginBottom: 18,
                      }}
                    >
                      <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700 }}>
                        Multimodal Screenshot &amp; PDF PII Guardrail
                      </h3>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
                          gap: 8,
                          marginBottom: 14,
                        }}
                      >
                        {(Object.keys(PII_CATEGORY_META) as PiiCategory[]).map((cat) => (
                          <label
                            key={cat}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '8px 10px',
                              border: '1px solid var(--rc-border)',
                              borderRadius: 5,
                              cursor: 'pointer',
                              fontSize: 13,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={Boolean(draft.piiConfig.categories[cat])}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  piiConfig: {
                                    ...draft.piiConfig,
                                    categories: {
                                      ...draft.piiConfig.categories,
                                      [cat]: e.target.checked,
                                    },
                                  },
                                })
                              }
                            />
                            {PII_CATEGORY_META[cat].label}
                          </label>
                        ))}
                      </div>

                      <div className="field-grid">
                        <div>
                          <label
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              fontSize: 13,
                              fontWeight: 600,
                              cursor: currentPlanDef.autoRedact ? 'pointer' : 'not-allowed',
                            }}
                          >
                            <input
                              type="checkbox"
                              disabled={!currentPlanDef.autoRedact}
                              checked={draft.piiConfig.autoRedactEnabled}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setAckIrreversibleChecked(false);
                                  setShowAutoRedactConfirm(true);
                                } else {
                                  setShowAutoRedactConfirm(false);
                                  setDraft({
                                    ...draft,
                                    piiConfig: {
                                      ...draft.piiConfig,
                                      autoRedactEnabled: false,
                                      autoRedactAcknowledgedIrreversible: false,
                                    },
                                  });
                                }
                              }}
                            />
                            Auto-redact PII attachments (Opt-in · strict &ge;0.95 confidence floor)
                            {!currentPlanDef.autoRedact && (
                              <span className="tag tag-neutral">Growth / Scale</span>
                            )}
                          </label>
                          <div style={{ fontSize: 12, color: 'var(--rc-ink-muted)', marginTop: 4 }}>
                            Off by default. Requires explicit admin confirmation and triggers only when
                            both PII probability and model confidence are &ge;0.95.
                          </div>

                          {showAutoRedactConfirm && (
                            <div
                              role="alertdialog"
                              aria-label="Confirm irreversible auto-redaction"
                              style={{
                                marginTop: 10,
                                padding: 12,
                                borderRadius: 6,
                                background: 'var(--rc-danger-soft)',
                                border: '1px solid var(--rc-danger-border)',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  color: 'var(--rc-danger)',
                                  fontWeight: 700,
                                  fontSize: 13,
                                  marginBottom: 6,
                                }}
                              >
                                <ShieldAlertIcon size={15} />
                                Irreversible Zendesk Attachment Deletion Warning
                              </div>
                              <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--rc-ink)' }}>
                                Enabling Auto-Redact will permanently delete matching ticket attachments
                                via Zendesk&apos;s Comment Redaction API whenever probability &ge;{' '}
                                <span className="mono">
                                  {Math.max(0.95, draft.piiConfig.autoRedactThreshold).toFixed(2)}
                                </span>{' '}
                                and confidence &ge; <span className="mono">0.95</span>. Redacted files
                                in Zendesk <strong>cannot be restored</strong>.
                              </p>
                              <label
                                style={{
                                  display: 'flex',
                                  alignItems: 'flex-start',
                                  gap: 8,
                                  fontSize: 12.5,
                                  fontWeight: 600,
                                  marginBottom: 10,
                                  cursor: 'pointer',
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={ackIrreversibleChecked}
                                  onChange={(e) => setAckIrreversibleChecked(e.target.checked)}
                                />
                                I am a Zendesk admin and confirm that automatic attachment deletion in
                                Zendesk is permanent and irreversible.
                              </label>
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <button
                                  type="button"
                                  className="btn btn-danger btn-sm"
                                  disabled={!ackIrreversibleChecked}
                                  onClick={() => {
                                    setDraft({
                                      ...draft,
                                      piiConfig: {
                                        ...draft.piiConfig,
                                        autoRedactEnabled: true,
                                        autoRedactAcknowledgedIrreversible: true,
                                        autoRedactThreshold: Math.max(
                                          0.95,
                                          draft.piiConfig.autoRedactThreshold,
                                        ),
                                      },
                                    });
                                    setShowAutoRedactConfirm(false);
                                    onNotify(
                                      'Auto-Redact armed (opt-in >= 0.95). Click Save changes to apply.',
                                    );
                                  }}
                                >
                                  Confirm &amp; enable Auto-Redact
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm"
                                  onClick={() => setShowAutoRedactConfirm(false)}
                                >
                                  Keep manual 1-click redaction
                                </button>
                              </div>
                            </div>
                          )}

                          {draft.piiConfig.autoRedactEnabled && (
                            <div className="field" style={{ marginTop: 10, maxWidth: 240 }}>
                              <label htmlFor="auto-redact-threshold">
                                Auto-redact probability floor (0.95–0.99)
                              </label>
                              <input
                                id="auto-redact-threshold"
                                type="number"
                                min={0.95}
                                max={0.99}
                                step={0.01}
                                className="input mono"
                                value={Math.max(0.95, draft.piiConfig.autoRedactThreshold)}
                                onChange={(e) =>
                                  setDraft({
                                    ...draft,
                                    piiConfig: {
                                      ...draft.piiConfig,
                                      autoRedactThreshold: Math.min(
                                        0.99,
                                        Math.max(0.95, Number(e.target.value) || 0.95),
                                      ),
                                    },
                                  })
                                }
                              />
                            </div>
                          )}
                        </div>
                        <div className="field">
                          <label htmlFor="img-res">Screenshot scan resolution</label>
                          <select
                            id="img-res"
                            className="select"
                            value={draft.piiConfig.imageResolution}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                piiConfig: {
                                  ...draft.piiConfig,
                                  imageResolution: e.target.value as RubricInput['piiConfig']['imageResolution'],
                                },
                              })
                            }
                          >
                            <option value="medium">Medium (lower token cost)</option>
                            <option value="high">High (recommended for IDs &amp; card digits)</option>
                            <option value="ultra_high">Ultra High (dense PDFs / tiny text)</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={savingRubric}
                        onClick={() => void handleSaveRubric()}
                      >
                        {savingRubric ? 'Saving…' : 'Save changes'}
                      </button>
                      {editingId && rubrics.length > 1 && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => void handleDeleteRubric(editingId)}
                        >
                          Delete rubric
                        </button>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {tab === 'tester' && (
                <section className="panel">
                  <div className="panel-header">
                    <h2 className="panel-title">Live Multimodal QA &amp; PII Sandbox Tester</h2>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setSimTicketId('10501');
                          setSimSubject('Double charge — photo of credit card attached');
                          setSimTranscript(
                            'Customer: Attached photo of my Visa 4532-1190-8821-4242 so you can refund me.\nAgent: Thanks! I refunded the duplicate charge today (3-5 business days) and flagged the card image for immediate removal.',
                          );
                          setSimFile({
                            filename: 'visa_credit_card_photo.png',
                            mimeType: 'image/png',
                          });
                        }}
                      >
                        Load Card PII Preset
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setSimTicketId('10502');
                          setSimSubject('Webhook 401 error — env screenshot attached');
                          setSimTranscript(
                            `Customer: Here is our terminal screenshot showing ${['sk', 'live', '51Nx9aTestKey12345'].join('_')} failing on webhook call.\nAgent: I see the issue — please rotate that live API key right away, and update your header to Bearer.`,
                          );
                          setSimFile({
                            filename: 'terminal_api_key_leak.pdf',
                            mimeType: 'application/pdf',
                          });
                        }}
                      >
                        Load API Key PDF Preset
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setSimTicketId('10503');
                          setSimSubject('How do I export monthly QA scores?');
                          setSimTranscript(
                            'Customer: Where can I export our team QA scores to CSV?\nAgent: Great question! Open RubricCheck QA from your Zendesk nav bar and click Export CSV in the Recent Evaluations panel. Let me know if you want a walkthrough.',
                          );
                          setSimFile(null);
                        }}
                      >
                        Load Clean Ticket Preset
                      </button>
                    </div>
                  </div>

                  <div className="panel-body">
                    <div className="field-grid" style={{ marginBottom: 14 }}>
                      <div className="field">
                        <label htmlFor="sim-ticket-id">Ticket ID</label>
                        <input
                          id="sim-ticket-id"
                          className="input mono"
                          value={simTicketId}
                          onChange={(e) => setSimTicketId(e.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="sim-assignee">Assignee</label>
                        <input
                          id="sim-assignee"
                          className="input"
                          value={simAssignee}
                          onChange={(e) => setSimAssignee(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="field" style={{ marginBottom: 14 }}>
                      <label htmlFor="sim-subject">Subject</label>
                      <input
                        id="sim-subject"
                        className="input"
                        value={simSubject}
                        onChange={(e) => setSimSubject(e.target.value)}
                      />
                    </div>

                    <div className="field" style={{ marginBottom: 14 }}>
                      <label htmlFor="sim-transcript">Ticket conversation transcript</label>
                      <textarea
                        id="sim-transcript"
                        className="textarea"
                        style={{ minHeight: 110 }}
                        value={simTranscript}
                        onChange={(e) => setSimTranscript(e.target.value)}
                      />
                    </div>

                    <div className="field" style={{ marginBottom: 16 }}>
                      <label htmlFor="sim-file">
                        Attach real test screenshot (PNG/JPG/WebP) or PDF (processed in RAM only)
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <input
                          id="sim-file"
                          type="file"
                          accept="image/png,image/jpeg,image/webp,application/pdf"
                          onChange={handleFileUpload}
                        />
                        {simFile && (
                          <span className="tag tag-neutral mono">
                            {simFile.filename} ({simFile.mimeType})
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={simRunning}
                      onClick={() => void handleRunSimulation()}
                    >
                      {simRunning ? 'Evaluating with gemini-decision-1…' : 'Run multimodal scan'}
                    </button>
                  </div>
                </section>
              )}

              {tab === 'billing' && billing && (
                <>
                  {/* Zendesk Global OAuth Connection */}
                  <section className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title">Zendesk Global OAuth 2.0 &amp; Event Webhooks</h2>
                      <span
                        className={`tag ${overview.tenant.oauthConnected ? 'tag-pass' : 'tag-warn'}`}
                      >
                        {overview.tenant.oauthConnected ? 'Connected' : 'Not connected'}
                      </span>
                    </div>
                    <div className="panel-body">
                      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--rc-ink-secondary)' }}>
                        Uses Zendesk OAuth 2.0 with automatic Refresh Token rotation and minimal
                        granular scopes (<span className="mono">tickets:read tickets:write webhooks:read webhooks:write</span>).
                        No permanent API tokens are ever requested or stored.
                      </p>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                          className="input mono"
                          style={{ maxWidth: 260 }}
                          aria-label="Zendesk subdomain"
                          placeholder="your-company"
                          value={zdSubdomainInput}
                          onChange={(e) => setZdSubdomainInput(e.target.value)}
                        />
                        <span className="mono" style={{ color: 'var(--rc-ink-muted)', fontSize: 13 }}>
                          .zendesk.com
                        </span>
                        <a
                          className="btn btn-primary"
                          href={`/oauth/zendesk/start?subdomain=${encodeURIComponent(zdSubdomainInput)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {overview.tenant.oauthConnected
                            ? 'Reconnect Zendesk OAuth'
                            : 'Connect Zendesk OAuth'}
                          <ExternalIcon size={13} />
                        </a>
                      </div>
                    </div>
                  </section>

                  {/* Flat-Rate Plans & Paddle Billing */}
                  <section className="panel">
                    <div className="panel-header">
                      <div>
                        <h2 className="panel-title">Flat-Rate Plans (Unlimited Agents)</h2>
                        <div style={{ fontSize: 12.5, color: 'var(--rc-ink-secondary)', marginTop: 2 }}>
                          Billed securely by Paddle (Merchant of Record · global VAT/tax handled).
                          {billing.environment === 'sandbox' && (
                            <span className="tag tag-warn" style={{ marginLeft: 8 }}>
                              Paddle Sandbox Mode
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <div className="mode-switcher" role="group" aria-label="Billing period">
                          <button
                            type="button"
                            className={`mode-btn ${!annualBilling ? 'active' : ''}`}
                            onClick={() => setAnnualBilling(false)}
                          >
                            Monthly
                          </button>
                          <button
                            type="button"
                            className={`mode-btn ${annualBilling ? 'active' : ''}`}
                            onClick={() => setAnnualBilling(true)}
                          >
                            Annual (Save 15%)
                          </button>
                        </div>
                        {billing.hasPortalAccess && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => void openCustomerPortal()}
                          >
                            Manage subscription
                            <ExternalIcon size={13} />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="panel-body">
                      <div className="pricing-grid">
                        {(['free', 'starter', 'growth', 'scale'] as PlanTier[]).map((tier) => {
                          const p = billing.plans[tier];
                          const isCurrent = billing.currentTier === tier;
                          const displayPrice = annualBilling ? p.annualMonthlyUsd : p.monthlyUsd;
                          return (
                            <div
                              key={tier}
                              className={`plan-col ${tier === 'growth' ? 'featured' : ''}`}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                }}
                              >
                                <strong style={{ fontSize: 15 }}>{p.name}</strong>
                                {isCurrent && <span className="tag tag-pass">Current</span>}
                                {!isCurrent && tier === 'growth' && (
                                  <span className="tag tag-neutral">Most popular</span>
                                )}
                              </div>
                              <div className="plan-price mono">
                                ${displayPrice}
                                <span
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 500,
                                    color: 'var(--rc-ink-muted)',
                                  }}
                                >
                                  /mo
                                </span>
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--rc-ink-secondary)' }}>
                                {p.tagline}
                              </div>

                              <ul className="plan-features">
                                <li>
                                  <CheckIcon size={14} />
                                  <span>
                                    Up to <strong>{p.monthlyTicketLimit.toLocaleString()}</strong>{' '}
                                    tickets/mo
                                  </span>
                                </li>
                                <li>
                                  <CheckIcon size={14} />
                                  <span>Unlimited Zendesk agents</span>
                                </li>
                                <li>
                                  <CheckIcon size={14} />
                                  <span>
                                    {p.maxRubrics >= 100
                                      ? 'Unlimited QA rubrics'
                                      : `${p.maxRubrics} custom rubric${p.maxRubrics > 1 ? 's' : ''}`}
                                  </span>
                                </li>
                                <li>
                                  <CheckIcon size={14} />
                                  <span>
                                    {p.autoRedact
                                      ? 'Auto-redact + 1-click PII scrub'
                                      : 'Screenshot/PDF PII flagging + 1-click scrub'}
                                  </span>
                                </li>
                                {p.csvExport && (
                                  <li>
                                    <CheckIcon size={14} />
                                    <span>QA &amp; compliance CSV export</span>
                                  </li>
                                )}
                              </ul>

                              {tier === 'free' ? (
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  disabled
                                >
                                  {isCurrent ? 'Active plan' : 'Included baseline'}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className={`btn ${tier === 'growth' ? 'btn-primary' : 'btn-secondary'}`}
                                  disabled={isCurrent}
                                  onClick={() => openPaddleCheckout(tier)}
                                >
                                  {isCurrent ? 'Current plan' : `Choose ${p.name}`}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </section>

                  <div className="privacy-bar" style={{ borderRadius: 6, border: '1px solid var(--rc-border)' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <LockIcon size={14} />
                      <strong>AI Privacy Guarantee:</strong> Customer ticket content and attachments
                      are never used to train AI models (Google Gemini Paid Tier) and are discarded
                      from RAM immediately after scanning.
                    </span>
                  </div>
                </>
              )}
            </>
          )
        )}
      </main>
    </div>
  );
}
