import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { ErrorBanner } from "../components.tsx";
import { useLedgerEvents } from "../events.tsx";

interface ClaimItem {
  id: string;
  task: string;
  agent: string;
  status: string;
  branch?: string | null;
  worktree?: string | null;
  claimed_at: string;
  released_at?: string | null;
  completed_at?: string | null;
}

interface TaskItem {
  id: string;
  title: string;
}

interface GitContext {
  activeClaims: ClaimItem[];
  overlaps: Array<{ task: string; otherTask: string; reason: string }>;
}

const CLAIM_STATUS_FILTERS = ["all", "active", "released", "completed", "stale"];

const CLAIM_STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  active: { label: "Active", bg: "rgba(79,140,255,0.14)", fg: "var(--accent)" },
  released: { label: "Released", bg: "var(--bg-hover)", fg: "var(--text-dim)" },
  completed: { label: "Completed", bg: "rgba(52,199,123,0.14)", fg: "var(--green)" },
  stale: { label: "Stale", bg: "rgba(239,83,80,0.14)", fg: "var(--red)" },
};

export function Claims() {
  const [claims, setClaims] = useState<ClaimItem[]>([]);
  const [tasks, setTasks] = useState<Map<string, TaskItem>>(new Map());
  const [overlaps, setOverlaps] = useState<GitContext["overlaps"]>([]);
  const [msg, setMsg] = useState("");
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { revision } = useLedgerEvents();

  const load = () => {
    api<TaskItem[]>("/api/tasks").then((r) => {
      if (r.ok && r.data) {
        const map = new Map<string, TaskItem>();
        for (const t of r.data) map.set(t.id, t);
        setTasks(map);
      }
    });
    api<ClaimItem[]>(`/api/claims${filter !== "all" ? `?status=${filter}` : ""}`).then((r) => {
      if (r.ok && r.data) {
        setClaims(r.data);
        setError(null);
      } else {
        setError(r.errors?.[0]?.message ?? "Failed to load claims");
      }
      setLoaded(true);
    });
    api<GitContext>("/api/git/context").then((r) => {
      if (r.ok && r.data) {
        setOverlaps(r.data.overlaps);
      }
    });
  };

  useEffect(() => {
    load();
  }, [filter, revision]);

  const releaseTask = async (taskId: string, agent: string) => {
    const r = await api(`/api/tasks/${taskId}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent }),
    });
    setMsg(r.ok ? "released" : r.errors?.[0]?.message ?? "error");
    if (r.ok) load();
  };

  return (
    <div>
      <h1>Claims</h1>
      <ErrorBanner message={error} onRetry={load} />
      {msg && (
        <div style={{ color: msg === "released" ? "var(--green)" : "var(--red)", marginBottom: 12 }}>
          {msg}
        </div>
      )}

      {overlaps.length > 0 && (
        <div className="panel" style={{ marginBottom: 20 }}>
          <div className="panel-header">Coordination Warnings</div>
          <div className="panel-body">
            {overlaps.map((o) => (
              <div
                key={`${o.task}-${o.otherTask}-${o.reason}`}
                style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}
              >
                <span style={{ fontFamily: "var(--mono)", color: "var(--orange)" }}>{o.task}</span>
                {" / "}
                <span style={{ fontFamily: "var(--mono)", color: "var(--orange)" }}>{o.otherTask}</span>
                {" - "}
                {o.reason}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="filter-chips">
        {CLAIM_STATUS_FILTERS.map((f) => {
          const meta = CLAIM_STATUS_META[f];
          return (
            <button
              key={f}
              className={`chip${filter === f ? " active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : (meta?.label ?? f)}
            </button>
          );
        })}
      </div>

      {claims.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {claims.map((c) => {
            const t = tasks.get(c.task);
            const sm = CLAIM_STATUS_META[c.status] ?? { label: c.status, bg: "var(--bg-hover)", fg: "var(--text-muted)" };
            return (
              <div key={c.id} className="issue-card" style={{ display: "flex", alignItems: "center", gap: 18 }}>
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    background: "var(--bg-hover)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--text-secondary)",
                    flexShrink: 0,
                  }}
                >
                  {c.agent.slice(0, 1).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "13.5px", fontWeight: 600 }}>{t?.title ?? c.task}</div>
                  <div
                    style={{
                      fontSize: "11.5px",
                      fontFamily: "var(--mono)",
                      color: "var(--text-dim)",
                      marginTop: 2,
                    }}
                  >
                    {c.agent} · {c.branch ?? "-"} · {c.claimed_at}
                  </div>
                </div>
                <span className="badge" style={{ background: sm.bg, color: sm.fg, width: 70 }}>
                  {sm.label}
                </span>
                {c.status === "active" && (
                  <button className="btn-action btn-action-warn" onClick={() => releaseTask(c.task, c.agent)}>
                    Release
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        loaded &&
        !error && (
          <div style={{ color: "var(--text-dim)", padding: 40, textAlign: "center" }}>
            No claims match this filter.
          </div>
        )
      )}
    </div>
  );
}
