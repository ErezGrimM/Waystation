import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

/**
 * Live ledger events. The dashboard server streams mutation events on
 * `GET /api/events` (SSE); this provider maintains a single EventSource for the
 * whole app and exposes:
 *   - `connected`: whether the stream is currently open;
 *   - `revision`: a counter bumped on each mutation event, which pages depend
 *     on to refetch. Bursts (e.g. a GitHub import creating many issues) are
 *     coalesced into one bump so pages don't refetch per-event (audit M5).
 */
interface LedgerEvents {
  connected: boolean;
  revision: number;
}

const LedgerEventsContext = createContext<LedgerEvents>({ connected: false, revision: 0 });

export function useLedgerEvents(): LedgerEvents {
  return useContext(LedgerEventsContext);
}

export function LedgerEventsProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  const coalesce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    // EventSource reconnects automatically; reflect the drop until it reopens.
    es.onerror = () => setConnected(false);
    es.onmessage = () => {
      if (coalesce.current) clearTimeout(coalesce.current);
      coalesce.current = setTimeout(() => setRevision((r) => r + 1), 150);
    };
    return () => {
      es.close();
      if (coalesce.current) clearTimeout(coalesce.current);
    };
  }, []);

  return (
    <LedgerEventsContext.Provider value={{ connected, revision }}>
      {children}
    </LedgerEventsContext.Provider>
  );
}
