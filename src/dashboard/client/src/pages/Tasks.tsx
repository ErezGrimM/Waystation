import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api.ts";

interface TaskItem {
  id: string;
  title: string;
  status: string;
  priority: number;
  scope?: string | null;
  created_at?: string;
  updated_at?: string;
  description?: string;
  acceptance?: string[];
  dependencies?: string[];
}

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  todo: { label: "Todo", bg: "#1c2430", fg: "#8b98a9" },
  ready: { label: "Ready", bg: "rgba(79,140,255,0.14)", fg: "#5b9bff" },
  in_progress: { label: "In Progress", bg: "rgba(245,166,35,0.14)", fg: "#f5a623" },
  blocked: { label: "Blocked", bg: "rgba(239,83,80,0.14)", fg: "#ef5350" },
  review: { label: "Review", bg: "rgba(167,139,250,0.14)", fg: "#a78bfa" },
  done: { label: "Done", bg: "rgba(52,199,123,0.14)", fg: "#34c77b" },
  wont_do: { label: "Won't do", bg: "#1c2430", fg: "#5a6472" },
};

const FILTERS = ["all", "todo", "ready", "in_progress", "blocked", "review", "done", "wont_do"];

type SortKey = "created_at" | "priority" | "title" | "updated_at";

export function Tasks() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") ?? "all";
  const [sort, setSort] = useState<SortKey>("created_at");
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const [agent, setAgent] = useState("opencode");
  const [msg, setMsg] = useState("");
  const msgTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flashMsg = (text: string) => {
    setMsg(text);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(""), 3000);
  };

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    params.set("sort", sort);
    params.set("order", order);
    api<TaskItem[]>(`/api/tasks?${params}`).then((r) => {
      if (r.ok && r.data) setTasks(r.data);
    });
  }, [status, sort, order]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleSort = (key: SortKey) => {
    if (sort === key) {
      setOrder((o) => (o === "desc" ? "asc" : "desc"));
    } else {
      setSort(key);
      setOrder("desc");
    }
  };

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const doAction = async (action: string, taskId: string) => {
    const r = await api(`/api/tasks/${taskId}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent }),
    });
    if (r.ok) {
      flashMsg(`${action}d ${taskId}`);
      load();
    } else {
      flashMsg(r.errors?.[0]?.message ?? `${action} failed`);
    }
  };

  return (
    <div>
      <h1>Tasks</h1>

      {msg && (
        <div style={{ color: "var(--green)", marginBottom: 12, fontSize: 12, fontFamily: "var(--mono)" }}>
          {msg}
        </div>
      )}

      <div className="filter-chips">
        {FILTERS.map((f) => {
          const meta = STATUS_META[f];
          return (
            <button
              key={f}
              className={`chip${status === f ? " active" : ""}`}
              onClick={() => setSearchParams(f === "all" ? {} : { status: f })}
            >
              {f === "all" ? "All" : meta!.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        {(
          [
            ["created_at", "Created"],
            ["updated_at", "Updated"],
            ["priority", "Priority"],
            ["title", "Title"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className="chip"
            onClick={() => toggleSort(key)}
            style={{
              background: sort === key ? "var(--accent)" : undefined,
              color: sort === key ? "#0a0e13" : undefined,
              borderColor: sort === key ? "var(--accent)" : undefined,
            }}
          >
            {label} {sort === key ? (order === "desc" ? "↓" : "↑") : ""}
          </button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-dim)" }}>Agent:</span>
        <input
          className="input"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          style={{ width: 120, padding: "6px 10px", fontSize: 12 }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tasks.map((t) => {
          const meta = STATUS_META[t.status] ?? { label: t.status, bg: "#1c2430", fg: "#8b98a9" };
          const isExpanded = expandedId === t.id;
          return (
            <div key={t.id}>
              <div
                className={`task-row${isExpanded ? " selected" : ""}`}
                onClick={() => setExpandedId(isExpanded ? null : t.id)}
                style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 14 }}
              >
                <span className="badge" style={{ background: meta!.bg, color: meta!.fg, width: 78 }}>
                  {meta!.label}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "13.5px", fontWeight: 600, color: "var(--text)" }}>
                    {t.title}
                  </div>
                  <div style={{ fontSize: "11.5px", fontFamily: "var(--mono)", color: "var(--text-dim)", marginTop: 2 }}>
                    {t.id} · {t.scope ?? "-"} · {t.created_at ?? ""}
                  </div>
                </div>
                <span className="badge" style={{ background: "var(--bg-hover)", color: "var(--text-muted)" }}>
                  P{t.priority}
                </span>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  {(t.status === "ready" || t.status === "todo") && (
                    <button className="btn-action" onClick={(e) => { e.stopPropagation(); doAction("claim", t.id); }}>Claim</button>
                  )}
                  {t.status === "in_progress" && (
                    <>
                      <button className="btn-action" onClick={(e) => { e.stopPropagation(); doAction("finish", t.id); }}>Finish</button>
                      <button className="btn-action btn-action-warn" onClick={(e) => { e.stopPropagation(); doAction("release", t.id); }}>Release</button>
                    </>
                  )}
                </div>
              </div>
              {isExpanded && (
                <div style={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--border-active)",
                  borderRadius: 10,
                  padding: 16,
                  marginBottom: 8,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div>
                      <Link to={`/tasks/${t.id}`} style={{ fontSize: 13, fontWeight: 700 }}>
                        View full detail →
                      </Link>
                      <div style={{ fontSize: "11.5px", color: "var(--text-dim)", marginTop: 2 }}>
                        P{t.priority}{t.scope ? ` · ${t.scope}` : ""}
                      </div>
                    </div>
                  </div>
                  {t.description && (
                    <div style={{ fontSize: "12.5px", color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 12 }}>
                      {t.description}
                    </div>
                  )}
                  {t.acceptance && t.acceptance.length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: "10.5px", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.3px", marginBottom: 5 }}>
                        Acceptance
                      </div>
                      {t.acceptance.map((a) => (
                        <div key={a} style={{ fontSize: "12px", color: "var(--text-muted)", marginLeft: 8, marginBottom: 2 }}>
                          ✓ {a}
                        </div>
                      ))}
                    </div>
                  )}
                  {t.dependencies && t.dependencies.length > 0 && (
                    <div>
                      <div style={{ fontSize: "10.5px", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.3px", marginBottom: 5 }}>
                        Dependencies
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {t.dependencies.map((d) => (
                          <span key={d} style={{ fontSize: 11, fontFamily: "var(--mono)", background: "var(--bg-hover)", color: "var(--text-muted)", padding: "2px 6px", borderRadius: 4 }}>
                            {d}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {tasks.length === 0 && (
          <div style={{ color: "var(--text-dim)", padding: 40, textAlign: "center" }}>
            No tasks match this filter.
          </div>
        )}
      </div>
    </div>
  );
}
