import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api.ts";
import { ErrorBanner, Placeholder } from "../components.tsx";

interface TaskData {
  id: string;
  title: string;
  status: string;
  priority: number;
  scope?: string | null;
  description?: string;
  acceptance?: string[];
  dependencies?: string[];
  prompts?: string[];
}

interface BriefData {
  task: { id: string; title: string; status: string; priority: number; scope: string | null };
  goal: string;
  acceptance: string[];
  blockedBy: string[];
  activeClaim: { id: string; agent: string } | null;
  nextAction: string;
}

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  ready: { label: "Ready", bg: "rgba(79,140,255,0.14)", fg: "#5b9bff" },
  in_progress: { label: "In Progress", bg: "rgba(245,166,35,0.14)", fg: "#f5a623" },
  blocked: { label: "Blocked", bg: "rgba(239,83,80,0.14)", fg: "#ef5350" },
  review: { label: "Review", bg: "rgba(167,139,250,0.14)", fg: "#a78bfa" },
  done: { label: "Done", bg: "rgba(52,199,123,0.14)", fg: "#34c77b" },
};

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<TaskData | null>(null);
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [agent, setAgent] = useState("opencode");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    // The task fetch gates the view; the brief is supplementary and its failure
    // must not blank the page.
    api<TaskData>(`/api/tasks/${id}`).then((r) => {
      if (r.ok && r.data) setTask(r.data);
      else setError(r.errors?.[0]?.message ?? "Failed to load task");
      setLoading(false);
    });
    api<BriefData>(`/api/tasks/${id}/brief`).then((r) => {
      if (r.ok && r.data) setBrief(r.data);
    });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const action = async (verb: "claim" | "release" | "finish") => {
    if (!id) return;
    const r = await api(`/api/tasks/${id}/${verb}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent }),
    });
    setMsg(r.ok ? `${verb} succeeded` : r.errors?.[0]?.message ?? "error");
    if (r.ok) {
      api<TaskData>(`/api/tasks/${id}`).then((t) => {
        if (t.ok && t.data) setTask(t.data);
      });
    }
  };

  const [copied, setCopied] = useState(false);

  if (loading) return <Placeholder>Loading…</Placeholder>;
  if (error) {
    return (
      <div>
        <ErrorBanner message={error} onRetry={load} />
      </div>
    );
  }
  if (!task) return <Placeholder>Task not found.</Placeholder>;

  const copyPrompt = () => {
    const text = [
      `# ${task.id} — ${task.title}`,
      task.description ? `\n${task.description}` : "",
      task.acceptance?.length
        ? `\n## Acceptance\n${task.acceptance.map((a) => `- ${a}`).join("\n")}`
        : "",
      brief ? `\n## Next action\n${brief.nextAction}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const meta = STATUS_META[task.status] ?? { label: task.status, bg: "#1c2430", fg: "#8b98a9" };

  return (
    <div>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "11.5px", fontFamily: "var(--mono)", color: "var(--text-dim)", marginBottom: 8 }}>
            {task.id}
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>{task.title}</div>

          <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
            <span className="badge" style={{ background: meta.bg, color: meta.fg }}>
              {meta.label}
            </span>
            <span className="badge" style={{ background: "var(--bg-hover)", color: "var(--text-muted)" }}>
              P{task.priority}
            </span>
            {task.scope && (
              <span className="badge" style={{ background: "var(--bg-hover)", color: "var(--text-muted)" }}>
                {task.scope}
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <button className="btn-primary" onClick={() => action("claim")}>
              Claim task
            </button>
            <button className="btn-secondary" onClick={() => action("release")}>
              Release
            </button>
            <button className="btn-outline" onClick={() => action("finish")}>
              Finish
            </button>
            <input
              className="input"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              placeholder="agent"
              style={{ width: 120, padding: "9px 12px" }}
            />
            <button className="btn-outline" onClick={copyPrompt}>
              {copied ? "Copied!" : "Copy prompt"}
            </button>
          </div>
          {msg && (
            <div style={{ color: msg.startsWith("error") ? "var(--red)" : "var(--green)", marginBottom: 12 }}>
              {msg}
            </div>
          )}

          {task.description && (
            <>
              <div className="section-label">Description</div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 18 }}>
                {task.description}
              </div>
            </>
          )}

          {task.acceptance && task.acceptance.length > 0 && (
            <>
              <div className="section-label">Acceptance</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 18 }}>
                {task.acceptance.map((a) => (
                  <div key={a} style={{ display: "flex", gap: 8, fontSize: "12.5px", color: "var(--text-secondary)", lineHeight: 1.4 }}>
                    <span style={{ color: "var(--accent)", flexShrink: 0 }}>✓</span>
                    <span>{a}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {task.dependencies && task.dependencies.length > 0 && (
            <>
              <div className="section-label">Dependencies</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
                {task.dependencies.map((d) => (
                  <span key={d} className="badge" style={{ background: "var(--bg-hover)", color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11 }}>
                    {d}
                  </span>
                ))}
              </div>
            </>
          )}

          {brief && (
            <>
              <div style={{ borderLeft: "2px solid var(--green)", paddingLeft: 16, marginTop: 20 }}>
                <div className="section-label">Next action</div>
                <div style={{ fontSize: "13.5px", color: "var(--text)", lineHeight: 1.5 }}>
                  {brief.nextAction}
                </div>
              </div>
            </>
          )}
        </div>

        {brief?.activeClaim && (
          <div className="detail-panel">
            <div className="section-label">Active claim</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
              {brief.activeClaim.agent}
            </div>
            <div style={{ fontSize: "11.5px", fontFamily: "var(--mono)", color: "var(--text-dim)", marginTop: 4 }}>
              {brief.activeClaim.id}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
