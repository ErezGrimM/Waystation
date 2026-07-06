import { useEffect, useState } from "react";
import { api } from "../api.ts";

interface TaskItem {
  id: string;
  title: string;
  status: string;
  priority: number;
  scope?: string | null;
}

interface BriefData {
  task: { id: string; title: string; status: string; priority: number; scope: string | null };
  goal: string;
  acceptance: string[];
  blockedBy: string[];
  scopeRules: string[];
  activeClaim: { id: string; agent: string } | null;
  nextAction: string;
  relatedFiles?: string[];
  concepts?: string[];
  impactHints?: string[];
}

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  ready: { label: "Ready", bg: "rgba(79,140,255,0.14)", fg: "#5b9bff" },
  in_progress: { label: "In Progress", bg: "rgba(245,166,35,0.14)", fg: "#f5a623" },
  blocked: { label: "Blocked", bg: "rgba(239,83,80,0.14)", fg: "#ef5350" },
  review: { label: "Review", bg: "rgba(167,139,250,0.14)", fg: "#a78bfa" },
  done: { label: "Done", bg: "rgba(52,199,123,0.14)", fg: "#34c77b" },
};

export function Brief() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [brief, setBrief] = useState<BriefData | null>(null);

  useEffect(() => {
    api<TaskItem[]>("/api/tasks").then((r) => {
      if (r.ok && r.data) setTasks(r.data);
    });
  }, []);

  const select = (id: string) => {
    setSelected(id);
    api<BriefData>(`/api/tasks/${id}/brief`).then((r) => {
      if (r.ok && r.data) setBrief(r.data);
    });
  };

  return (
    <div>
      <h1>Brief</h1>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="section-label" style={{ padding: "0 4px" }}>Select a task</div>
          {tasks.map((t) => (
            <div
              key={t.id}
              className={`msg-thread-item${selected === t.id ? " active" : ""}`}
              onClick={() => select(t.id)}
            >
              <div style={{ fontSize: "12.5px", fontWeight: 600, color: "#dbe2ea" }}>{t.title}</div>
              <div style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--text-dim)", marginTop: 2 }}>
                {t.id}
              </div>
            </div>
          ))}
        </div>

        {brief && (
          <div style={{ flex: 1, minWidth: 0, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: "28px 32px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", letterSpacing: "0.6px", textTransform: "uppercase", marginBottom: 8 }}>
              Generated brief · budget: medium
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>{brief.task.title}</div>
            <div style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text-dim)", marginBottom: 24 }}>
              {brief.task.id}
            </div>

            <div style={{ borderLeft: "2px solid var(--accent)", paddingLeft: 16, marginBottom: 22 }}>
              <div className="section-label">Goal & status</div>
              <div style={{ fontSize: "13.5px", color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 10 }}>
                {brief.goal}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <span
                  className="badge"
                  style={{
                    background: STATUS_META[brief.task.status]?.bg ?? "var(--bg-hover)",
                    color: STATUS_META[brief.task.status]?.fg ?? "var(--text-muted)",
                  }}
                >
                  {STATUS_META[brief.task.status]?.label ?? brief.task.status}
                </span>
                <span className="badge" style={{ background: "var(--bg-hover)", color: "var(--text-muted)" }}>
                  P{brief.task.priority}
                </span>
              </div>
            </div>

            {brief.scopeRules.length > 0 && (
              <div style={{ borderLeft: "2px solid #2a3340", paddingLeft: 16, marginBottom: 22 }}>
                <div className="section-label">Scope rules · {brief.task.scope ?? "-"}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {brief.scopeRules.map((r) => (
                    <div key={r} style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                      — {r}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {brief.acceptance.length > 0 && (
              <div style={{ borderLeft: "2px solid #2a3340", paddingLeft: 16, marginBottom: 22 }}>
                <div className="section-label">Acceptance criteria</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {brief.acceptance.map((a) => (
                    <div key={a} style={{ display: "flex", gap: 8, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                      <span style={{ color: "var(--accent)", flexShrink: 0 }}>✓</span>
                      <span>{a}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {brief.blockedBy.length > 0 && (
              <div style={{ borderLeft: "2px solid var(--red)", paddingLeft: 16, marginBottom: 22 }}>
                <div className="section-label">Blocked by</div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                  {brief.blockedBy.join(", ")}
                </div>
              </div>
            )}

            {brief.activeClaim && (
              <div style={{ borderLeft: "2px solid var(--orange)", paddingLeft: 16, marginBottom: 22 }}>
                <div className="section-label">Active claim</div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                  {brief.activeClaim.agent} ({brief.activeClaim.id})
                </div>
              </div>
            )}

            {brief.relatedFiles && brief.relatedFiles.length > 0 && (
              <div style={{ borderLeft: "2px solid #2a3340", paddingLeft: 16, marginBottom: 22 }}>
                <div className="section-label">Related files</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {brief.relatedFiles.slice(0, 10).map((f) => (
                    <div key={f} style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text-secondary)" }}>
                      {f}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {brief.concepts && brief.concepts.length > 0 && (
              <div style={{ borderLeft: "2px solid #2a3340", paddingLeft: 16, marginBottom: 22 }}>
                <div className="section-label">Concepts</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {brief.concepts.slice(0, 5).map((c) => (
                    <div key={c} style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                      {c}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {brief.impactHints && brief.impactHints.length > 0 && (
              <div style={{ borderLeft: "2px solid var(--orange)", paddingLeft: 16, marginBottom: 22 }}>
                <div className="section-label">Impact hints</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {brief.impactHints.slice(0, 5).map((h) => (
                    <div key={h} style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                      {h}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ borderLeft: "2px solid var(--green)", paddingLeft: 16 }}>
              <div className="section-label">Next recommended action</div>
              <div style={{ fontSize: "13.5px", color: "var(--text)", lineHeight: 1.5 }}>
                {brief.nextAction}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
