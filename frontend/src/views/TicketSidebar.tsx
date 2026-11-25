import React, { useEffect, useState } from 'react';
import { PII_CATEGORY_META, type PlanTier } from '@rubriccheck/shared';
import type { ApiClient, EvaluationDTO, PiiFindingDTO } from '../lib/api';
import {
  BrandMark,
  CheckIcon,
  ExternalIcon,
  LockIcon,
  RefreshIcon,
  ShieldAlertIcon,
} from '../components/Icons';

interface Props {
  api: ApiClient;
  ticketId: string;
  ticketSubject: string;
  subdomain: string;
  oauthConnected: boolean;
  onOpenDashboard: () => void;
  onNotify: (msg: string) => void;
}

export function TicketSidebar({
  api,
  ticketId,
  ticketSubject,
  subdomain,
  oauthConnected,
  onOpenDashboard,
  onNotify,
}: Props) {
  const [evaluation, setEvaluation] = useState<EvaluationDTO | null>(null);
  const [findings, setFindings] = useState<PiiFindingDTO[]>([]);
  const [quota, setQuota] = useState<{ used: number; limit: number; planTier: PlanTier }>({
    used: 0,
    limit: 100,
    planTier: 'free',
  });
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyFindingId, setBusyFindingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadTicketState() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getTicketEvaluation(ticketId);
      setEvaluation(data.evaluation);
      setFindings(data.piiFindings);
      setQuota(data.quota);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTicketState();
  }, [ticketId]);

  async function handleScan(mode: 'live' | 'demo-pii' | 'demo-clean' = 'live') {
    setScanning(true);
    setError(null);
    try {
      if (mode === 'live' && oauthConnected) {
        const res = await api.evaluateTicket(ticketId);
        setEvaluation(res.evaluation);
        setFindings(res.piiFindings);
        setQuota((q) => ({ ...q, used: res.quota.used, limit: res.quota.limit }));
        onNotify(`Ticket #${ticketId} scored ${res.evaluation.overallScore}/100`);
      } else {
        const isPii = mode !== 'demo-clean';
        const res = await api.simulateTicket({
          ticketId,
          subject: ticketSubject || `Ticket #${ticketId}`,
          assigneeName: 'Noa Tal',
          transcriptText: isPii
            ? 'Customer: Hi, I was billed twice today. Here is a screenshot of my Visa credit card 4532-1190-8821-4242 and receipt.\nAgent: Hi there! Thanks for reaching out. I located the duplicate charge on invoice #8821 and issued a full refund back to your card (3-5 business days). Please avoid sending full card photos for your security.'
            : 'Customer: Can I add 3 more team members to my Starter workspace?\nAgent: Happy to help! Yes, all plans include unlimited seats. Go to Settings > Team > Invite Members, and your new teammates will get instant access. Let me know if you need anything else.',
          attachments: isPii
            ? [
                {
                  attachmentId: `att_${ticketId}_card`,
                  commentId: `cmt_${ticketId}_1`,
                  filename: 'customer_visa_card_photo.png',
                  mimeType: 'image/png',
                },
              ]
            : [],
        });
        setEvaluation(res.evaluation);
        setFindings(res.piiFindings);
        setQuota((q) => ({ ...q, used: res.quota.used, limit: res.quota.limit }));
        onNotify(
          res.evaluation.piiDetected
            ? `PII alert flagged on #${ticketId} (${res.evaluation.piiSeverity})`
            : `Ticket #${ticketId} passed QA (${res.evaluation.overallScore}/100)`,
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function handleRedact(findingId: string) {
    setBusyFindingId(findingId);
    setError(null);
    try {
      const res = await api.redactFinding(findingId);
      setFindings((prev) => prev.map((f) => (f.id === findingId ? res.finding : f)));
      setConfirmingId(null);
      onNotify(`Attachment "${res.finding.attachmentFilename}" redacted`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyFindingId(null);
    }
  }

  async function handleDismiss(findingId: string) {
    setBusyFindingId(findingId);
    try {
      const res = await api.dismissFinding(findingId);
      setFindings((prev) => prev.map((f) => (f.id === findingId ? res.finding : f)));
      onNotify('PII alert dismissed');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyFindingId(null);
    }
  }

  const openFindings = findings.filter((f) => f.status === 'flagged');
  const redactedFindings = findings.filter((f) => f.status === 'redacted');
  const quotaPct = Math.min(100, Math.round((quota.used / Math.max(1, quota.limit)) * 100));

  return (
    <div className="sidebar-shell" role="region" aria-label="RubricCheck QA Ticket Sidebar">
      <header className="sidebar-header">
        <div className="brand-lockup">
          <BrandMark size={22} />
          <div>
            <div className="brand-name">RubricCheck QA</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--rc-ink-muted)' }}>
              #{ticketId} · {subdomain}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={scanning}
          onClick={() => void handleScan(oauthConnected ? 'live' : 'demo-pii')}
        >
          <RefreshIcon size={13} />
          {scanning ? 'Scanning…' : evaluation ? 'Re-scan' : 'Scan ticket'}
        </button>
      </header>

      {error && (
        <div
          style={{
            padding: '10px 14px',
            background: 'var(--rc-danger-soft)',
            color: 'var(--rc-danger)',
            borderBottom: '1px solid var(--rc-danger-border)',
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}

      {/* PII Guardrail Alert Strip */}
      {openFindings.length > 0 && (
        <section className="pii-alert-strip" aria-live="polite">
          <h2 className="pii-alert-title">
            <ShieldAlertIcon size={16} />
            Exposed PII detected in {openFindings.length} attachment
            {openFindings.length > 1 ? 's' : ''}
          </h2>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--rc-ink-secondary)' }}>
            Sensitive data found via multimodal scan. Redact permanently from Zendesk storage.
          </p>

          {openFindings.map((finding) => (
            <div key={finding.id} className="pii-item">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 6,
                }}
              >
                <strong style={{ fontSize: 12.5, wordBreak: 'break-all' }}>
                  {finding.attachmentFilename}
                </strong>
                <span className="tag tag-danger mono">
                  {Math.round(finding.maxProbability * 100)}%
                </span>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
                {finding.piiCategories.map((cat) => (
                  <span key={cat} className="tag tag-neutral" style={{ fontSize: 11 }}>
                    {PII_CATEGORY_META[cat]?.label ?? cat}
                  </span>
                ))}
              </div>

              {confirmingId === finding.id ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busyFindingId === finding.id}
                    onClick={() => void handleRedact(finding.id)}
                  >
                    {busyFindingId === finding.id ? 'Redacting…' : 'Confirm permanent redact'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setConfirmingId(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => setConfirmingId(finding.id)}
                  >
                    Redact attachment
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busyFindingId === finding.id}
                    onClick={() => void handleDismiss(finding.id)}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {/* Redacted Confirmation Strip */}
      {openFindings.length === 0 && redactedFindings.length > 0 && (
        <section
          className="sidebar-section"
          style={{ background: 'var(--rc-forest-soft)', borderColor: 'var(--rc-forest-border)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--rc-forest)' }}>
            <CheckIcon size={15} />
            <strong style={{ fontSize: 13 }}>
              {redactedFindings.length} PII attachment{redactedFindings.length > 1 ? 's' : ''}{' '}
              redacted
            </strong>
          </div>
          {redactedFindings.map((f) => (
            <div key={f.id} style={{ fontSize: 12, color: 'var(--rc-ink-secondary)', marginTop: 4 }}>
              <span className="mono">{f.attachmentFilename}</span> scrubbed by{' '}
              {f.redactedBy || 'Agent'}
            </div>
          ))}
        </section>
      )}

      {/* Main QA Scorecard Section */}
      <main style={{ flex: 1 }}>
        {loading ? (
          <div className="sidebar-section" style={{ color: 'var(--rc-ink-secondary)' }}>
            Loading ticket evaluation…
          </div>
        ) : !evaluation ? (
          <div className="sidebar-section">
            <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700 }}>
              Not evaluated yet
            </h2>
            <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--rc-ink-secondary)' }}>
              Scan this ticket and its attached screenshots or PDFs against your QA rubric and PII
              guardrail in ~200ms.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={scanning}
                onClick={() => void handleScan(oauthConnected ? 'live' : 'demo-pii')}
              >
                {oauthConnected ? 'Evaluate ticket & attachments' : 'Run PII screenshot test scan'}
              </button>
              {!oauthConnected && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={scanning}
                  onClick={() => void handleScan('demo-clean')}
                >
                  Run clean ticket test scan
                </button>
              )}
            </div>
          </div>
        ) : (
          <section className="sidebar-section">
            <div className="score-header">
              <div>
                <div style={{ fontSize: 12, color: 'var(--rc-ink-secondary)', marginBottom: 4 }}>
                  {evaluation.rubricName}
                </div>
                <div className="score-big mono">
                  {evaluation.overallScore}
                  <span style={{ fontSize: 15, fontWeight: 500, color: 'var(--rc-ink-muted)' }}>
                    /100
                  </span>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className={`tag ${evaluation.passed ? 'tag-pass' : 'tag-warn'}`}>
                  {evaluation.passed ? 'QA Pass' : 'Needs Review'}
                </span>
                <div
                  className="mono"
                  style={{ fontSize: 11, color: 'var(--rc-ink-muted)', marginTop: 5 }}
                >
                  {evaluation.latencyMs}ms · {evaluation.attachmentCount} file
                  {evaluation.attachmentCount === 1 ? '' : 's'}
                </div>
              </div>
            </div>

            <div className="meter-track" aria-hidden="true">
              <div
                className="meter-fill"
                style={{
                  width: `${evaluation.overallScore}%`,
                  background: evaluation.passed ? 'var(--rc-forest)' : 'var(--rc-warn)',
                }}
              />
            </div>

            {evaluation.hasCriticalFail && (
              <div
                className="tag tag-danger"
                style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
              >
                Critical compliance criterion failed
              </div>
            )}

            <div className="criteria-list">
              {evaluation.criteriaResults.map((c) => (
                <div key={c.criterionId} className="criterion-row">
                  <div className="criterion-top">
                    <span style={{ fontWeight: 500, color: 'var(--rc-ink)' }}>{c.label}</span>
                    <span
                      className="mono"
                      style={{
                        fontWeight: 600,
                        color: c.criticalFailed
                          ? 'var(--rc-danger)'
                          : c.passed
                            ? 'var(--rc-forest)'
                            : 'var(--rc-warn)',
                      }}
                    >
                      {c.kind === 'score'
                        ? `${c.rawValue.toFixed(1)}/${c.maxValue}`
                        : c.passed
                          ? 'Yes'
                          : 'No'}
                    </span>
                  </div>
                  <div className="meter-track">
                    <div
                      className="meter-fill"
                      style={{
                        width: `${c.normalizedScore}%`,
                        background: c.criticalFailed
                          ? 'var(--rc-danger)'
                          : c.passed
                            ? 'var(--rc-forest)'
                            : 'var(--rc-warn)',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Quota & Dashboard Link */}
        <section className="sidebar-section" style={{ borderBottom: 'none' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 12,
              color: 'var(--rc-ink-secondary)',
              marginBottom: 5,
            }}
          >
            <span>Monthly ticket quota ({quota.planTier})</span>
            <span className="mono">
              {quota.used} / {quota.limit.toLocaleString()}
            </span>
          </div>
          <div className="meter-track" style={{ marginBottom: 12 }}>
            <div
              className="meter-fill"
              style={{
                width: `${quotaPct}%`,
                background: quotaPct >= 90 ? 'var(--rc-danger)' : 'var(--rc-forest)',
              }}
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ width: '100%' }}
            onClick={onOpenDashboard}
          >
            Open QA &amp; PII Dashboard
            <ExternalIcon size={13} />
          </button>
        </section>
      </main>

      <footer className="privacy-bar">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <LockIcon size={12} />
          RAM-only scan · Zero training
        </span>
        <span className="mono">gemini-decision-1</span>
      </footer>
    </div>
  );
}
