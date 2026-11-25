interface ZafClientLike {
  get: (paths: string | string[]) => Promise<Record<string, unknown>>;
  invoke: (cmd: string, ...args: unknown[]) => Promise<unknown>;
}

declare global {
  interface Window {
    ZAFClient?: { init: () => ZafClientLike };
    Paddle?: {
      Environment?: { set: (env: 'sandbox' | 'production') => void };
      Initialize: (opts: { token: string }) => void;
      Checkout: {
        open: (opts: {
          items: Array<{ priceId: string; quantity: number }>;
          customData?: Record<string, string>;
          settings?: { displayMode?: string; theme?: string; locale?: string };
        }) => void;
      };
    };
  }
}

export interface ZafContextState {
  inZendesk: boolean;
  ticketId: string;
  ticketSubject: string;
  resize: (heightPx: number) => void;
}

export async function initZafBridge(fallbackTicketId = '10482'): Promise<ZafContextState> {
  try {
    if (window.ZAFClient && window.parent !== window) {
      const client = window.ZAFClient.init();
      const data = await client.get(['ticket.id', 'ticket.subject']);
      const ticketId = data['ticket.id'] ? String(data['ticket.id']) : fallbackTicketId;
      const ticketSubject = data['ticket.subject'] ? String(data['ticket.subject']) : '';
      return {
        inZendesk: true,
        ticketId,
        ticketSubject,
        resize: (h: number) => {
          void client.invoke('resize', { width: '100%', height: `${Math.max(320, h)}px` });
        },
      };
    }
  } catch {
    // Running outside Zendesk iframe (standalone browser / local QA mode)
  }

  return {
    inZendesk: false,
    ticketId: fallbackTicketId,
    ticketSubject: 'Double charge on my Visa card — screenshot attached',
    resize: () => {},
  };
}
