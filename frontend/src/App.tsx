import React, { useEffect, useMemo, useState } from 'react';
import { ApiClient } from './lib/api';
import { initZafBridge } from './lib/zaf';
import { Dashboard } from './views/Dashboard';
import { TicketSidebar } from './views/TicketSidebar';

type ViewMode = 'sidebar' | 'dashboard';

function parseBootParams(): {
  view: ViewMode;
  sessionToken: string;
  ticketId: string;
  subdomain: string;
  hidePreviewBar: boolean;
} {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const viewParam = query.get('view') === 'sidebar' ? 'sidebar' : 'dashboard';
  const sessionToken = hash.get('session') || '';
  const ticketId = query.get('ticket_id') || '10482';
  const subdomain = (query.get('subdomain') || 'acme-support')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '') || 'acme-support';
  const hidePreviewBar = query.get('embed') === '1';
  return { view: viewParam, sessionToken, ticketId, subdomain, hidePreviewBar };
}

export function App() {
  const initial = useMemo(() => parseBootParams(), []);
  const [view, setView] = useState<ViewMode>(initial.view);
  const [inZendesk, setInZendesk] = useState(false);
  const [ticketId, setTicketId] = useState(initial.ticketId);
  const [ticketSubject, setTicketSubject] = useState('');
  const [subdomain, setSubdomain] = useState(initial.subdomain);
  const [oauthConnected, setOauthConnected] = useState(false);
  const [api, setApi] = useState<ApiClient | null>(
    initial.sessionToken ? new ApiClient(initial.sessionToken) : null,
  );
  const [bootError, setBootError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function notify(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4200);
  }

  useEffect(() => {
    let active = true;
    async function boot() {
      const bridge = await initZafBridge(initial.ticketId);
      if (!active) return;
      setInZendesk(bridge.inZendesk);
      setTicketId(bridge.ticketId);
      setTicketSubject(bridge.ticketSubject);

      let client = api;
      if (!client) {
        try {
          const dev = await ApiClient.bootstrapDevSession(initial.subdomain);
          if (!active) return;
          client = new ApiClient(dev.token);
          setSubdomain(dev.subdomain);
          setApi(client);
        } catch (err) {
          if (active) setBootError((err as Error).message);
          return;
        }
      }

      try {
        const ov = await client.getOverview();
        if (!active) return;
        setSubdomain(ov.tenant.zendeskSubdomain);
        setOauthConnected(ov.tenant.oauthConnected);
      } catch {
        // Handled inside individual views
      }

      if (bridge.inZendesk) {
        bridge.resize(620);
      }
    }
    void boot();
    return () => {
      active = false;
    };
  }, []);

  if (bootError) {
    return (
      <div style={{ padding: 24, maxWidth: 480, margin: '40px auto' }}>
        <h2>Unable to initialize RubricCheck QA</h2>
        <p style={{ color: 'var(--rc-ink-secondary)' }}>{bootError}</p>
      </div>
    );
  }

  if (!api) {
    return (
      <div style={{ padding: 24, color: 'var(--rc-ink-secondary)' }}>
        Connecting to RubricCheck QA…
      </div>
    );
  }

  return (
    <>
      {!inZendesk && !initial.hidePreviewBar && (
        <div
          style={{
            background: '#0f1c24',
            color: '#e5edf1',
            padding: '6px 14px',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span>
            Zendesk ZAF Workspace Preview · <strong className="mono">{subdomain}.zendesk.com</strong>
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className={`btn btn-sm ${view === 'sidebar' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setView('sidebar')}
            >
              Ticket Sidebar (320px)
            </button>
            <button
              type="button"
              className={`btn btn-sm ${view === 'dashboard' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setView('dashboard')}
            >
              Nav Bar Dashboard
            </button>
          </div>
        </div>
      )}

      {view === 'sidebar' ? (
        <TicketSidebar
          api={api}
          ticketId={ticketId}
          ticketSubject={ticketSubject}
          subdomain={subdomain}
          oauthConnected={oauthConnected}
          onOpenDashboard={() => setView('dashboard')}
          onNotify={notify}
        />
      ) : (
        <Dashboard
          api={api}
          onInspectTicket={(id) => {
            setTicketId(id);
            setView('sidebar');
          }}
          onNotify={notify}
        />
      )}

      {toast && (
        <div className="toast-banner" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </>
  );
}
