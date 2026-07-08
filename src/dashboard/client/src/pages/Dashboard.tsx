import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";

interface TaskBrief {
  id: string;
  title: string;
  status: string;
  priority: number;
  scope?: string | null;
  created_at?: string;
  description?: string;
  acceptance?: string[];
  dependencies?: string[];
}

interface StatusData {
  total: number;
  counts: Record<string, number>;
  next: TaskBrief | null;
}

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  todo: { label: "Todo", bg: "#1c2430", fg: "#8b98a9" },
  ready: { label: "Ready", bg: "rgba(79,140,255,0.14)", fg: "#5b9bff" },
  in_progress: { label: "In Progress", bg: "rgba(245,166,35,0.14)", fg: "#f5a623" },
  blocked: { label: "Blocked", bg: "rgba(239,83,80,0.14)", fg: "#ef5350" },
  review: { label: "Review", bg: "rgba(167,139,250,0.14)", fg: "#a78bfa" },
  done: { label: "Done", bg: "rgba(52,199,123,0.14)", fg: "#34c77b" },
};

const KANBAN_COLS = ["ready", "in_progress", "blocked", "review", "done"];

const STATUS_COLORS: Record<string, string> = {
  ready: "#5b9bff",
  in_progress: "#f5a623",
  blocked: "#ef5350",
  review: "#a78bfa",
  done: "#34c77b",
};

function ExpandedTask({
  task,
  agent,
  onAction,
  onClose,
}: {
  task: TaskBrief;
  agent: string;
  onAction: (action: string, taskId: string) => void;
  onClose: () => void;
}) {
  return (
    <div style={{
      background: "var(--bg-card)",
      border: "1px solid var(--border-active)",
      borderRadius: 8,
      padding: 14,
      marginTop: 6,
      marginBottom: 6,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <Link to={`/tasks/${task.id}`} style={{ fontSize: "13px", fontWeight: 700, color: "var(--accent)" }}>
            {task.id}
          </Link>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: 2 }}>
            P{task.priority}{task.scope ? ` · ${task.scope}` : ""}
          </div>
        </div>
        <button className="btn-action btn-action-warn" onClick={onClose} style={{ fontSize: 10 }}>Close</button>
      </div>

      {task.description && (
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 10 }}>
          {task.description}
        </div>
      )}

      {task.acceptance && task.acceptance.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: "10.5px", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.3px", marginBottom: 5 }}>
            Acceptance
          </div>
          {task.acceptance.map((a) => (
            <div key={a} style={{ fontSize: "11.5px", color: "var(--text-muted)", marginLeft: 8, marginBottom: 2 }}>
              ✓ {a}
            </div>
          ))}
        </div>
      )}

      {task.dependencies && task.dependencies.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: "10.5px", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.3px", marginBottom: 5 }}>
            Dependencies
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {task.dependencies.map((d) => (
              <span key={d} style={{ fontSize: 11, fontFamily: "var(--mono)", background: "var(--bg-hover)", color: "var(--text-muted)", padding: "2px 6px", borderRadius: 4 }}>
                {d}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
        {(task.status === "ready" || task.status === "todo") && (
          <button className="btn-action" onClick={() => onAction("claim", task.id)}>Claim</button>
        )}
        {task.status === "in_progress" && (
          <>
            <button className="btn-action" onClick={() => onAction("finish", task.id)}>Finish</button>
            <button className="btn-action btn-action-warn" onClick={() => onAction("release", task.id)}>Release</button>
          </>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", alignSelf: "center" }}>
          Agent: {agent}
        </span>
      </div>
    </div>
  );
}

export function Dashboard() {
  const [data, setData] = useState<StatusData | null>(null);
  const [tasks, setTasks] = useState<TaskBrief[]>([]);
  const [agent, setAgent] = useState("opencode");
  const [msg, setMsg] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(() => {
    api<StatusData>("/api/status").then((r) => {
      if (r.ok) setData(r.data);
    });
    api<TaskBrief[]>("/api/tasks").then((r) => {
      if (r.ok && r.data) setTasks(r.data);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const flashMsg = (text: string) => {
    setMsg(text);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(""), 3000);
  };

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

  const grouped: Record<string, TaskBrief[]> = {};
  for (const col of KANBAN_COLS) grouped[col] = [];
  for (const t of tasks) {
    if (grouped[t.status]) grouped[t.status]!.push(t);
  }

  const statCards = [
    { label: "Ready", value: data?.counts.ready ?? 0, color: STATUS_COLORS.ready },
    { label: "In progress", value: data?.counts.in_progress ?? 0, color: STATUS_COLORS.in_progress },
    { label: "Blocked", value: data?.counts.blocked ?? 0, color: STATUS_COLORS.blocked },
    { label: "Review", value: data?.counts.review ?? 0, color: STATUS_COLORS.review },
    { label: "Done", value: data?.counts.done ?? 0, color: STATUS_COLORS.done },
  ];

  return (
    <div>
      <div className="stat-grid">
        {statCards.map((s) => (
          <div key={s.label} className="stat-card">
            <div className="stat-value" style={{ color: s.color }}>
              {s.value}
            </div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {msg && (
        <div style={{ color: "var(--green)", marginBottom: 12, fontSize: 12, fontFamily: "var(--mono)" }}>
          {msg}
        </div>
      )}

      <div className="board">
        {KANBAN_COLS.map((col) => {
          const meta = STATUS_META[col]!;
          const items = grouped[col] ?? [];
          items.sort((a, b) => a.priority - b.priority || (a.created_at ?? "").localeCompare(b.created_at ?? ""));
          return (
            <div key={col}>
              <div className="board-col-label">
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.fg, flexShrink: 0 }} />
                {meta.label}
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)" }}>{items.length}</span>
              </div>
              <div className="board-cards">
                {items.map((t) => (
                  <div key={t.id}>
                    <div
                      className={`board-card${expandedId === t.id ? " board-card-expanded" : ""}`}
                      onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                    >
                      <div className="board-card-id">{t.id}</div>
                      <div className="board-card-title">{t.title}</div>
                      <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                        {(col === "ready" || col === "todo") && (
                          <button className="btn-action" onClick={(e) => { e.stopPropagation(); doAction("claim", t.id); }}>
                            Claim
                          </button>
                        )}
                        {col === "in_progress" && (
                          <>
                            <button className="btn-action" onClick={(e) => { e.stopPropagation(); doAction("finish", t.id); }}>
                              Finish
                            </button>
                            <button className="btn-action btn-action-warn" onClick={(e) => { e.stopPropagation(); doAction("release", t.id); }}>
                              Release
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {expandedId === t.id && (
                      <ExpandedTask task={t} agent={agent} onAction={doAction} onClose={() => setExpandedId(null)} />
                    )}
                  </div>
                ))}
                {items.length === 0 && (
                  <div style={{ fontSize: 11.5, color: "var(--text-dim)", padding: "12px 0", textAlign: "center" }}>
                    Empty
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 20, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Claiming as:</span>
        <input
          className="input"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          style={{ width: 140, padding: "6px 10px", fontSize: 12 }}
        />
      </div>
    </div>
  );
}
