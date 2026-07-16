import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type CommandDiagnostic, firstError } from "../api.ts";
import { DiagnosticBanner, ErrorBanner, Placeholder } from "../components.tsx";
import {
  claimDisabledReason,
  STATUS_TRANSITIONS,
  type TaskReadiness,
  type TaskStatus,
} from "../lifecycle.ts";

interface TaskData {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  scope?: string | null;
  description?: string;
  notes?: string;
  acceptance?: string[];
  dependencies?: string[];
  prompts?: string[];
  readiness: TaskReadiness;
  ledgerRoot: string;
}

interface BriefData {
  task: { id: string; title: string; status: string; priority: number; scope: string | null };
  blockedBy: string[];
  activeClaim: { id: string; agent: string } | null;
  nextAction: string;
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

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<TaskData | null>(null);
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [agent, setAgent] = useState("codex");
  const [message, setMessage] = useState("");
  const [commandError, setCommandError] = useState<CommandDiagnostic | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState(3);
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    api<TaskData>(`/api/tasks/${id}`).then((result) => {
      if (result.ok && result.data) {
        setTask(result.data);
        setTitle(result.data.title);
        setPriority(result.data.priority);
        setDescription(result.data.description ?? "");
        setNotes(result.data.notes ?? "");
      } else {
        setError(firstError(result, "Failed to load task").message);
      }
      setLoading(false);
    });
    api<BriefData>(`/api/tasks/${id}/brief`).then((result) => {
      if (result.ok && result.data) setBrief(result.data);
    });
  }, [id]);

  useEffect(() => load(), [load]);

  const run = async (path: string, body: Record<string, unknown>, success: string) => {
    const result = await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!result.ok) {
      setCommandError(firstError(result));
      setMessage("");
      return;
    }
    setCommandError(null);
    setMessage(success);
    load();
  };

  const taskAction = (verb: "claim" | "release" | "finish") => {
    if (!id) return;
    void run(`/api/tasks/${id}/${verb}`, { agent }, `${verb} succeeded`);
  };

  const setStatus = (status: TaskStatus) => {
    if (!id) return;
    void run(`/api/tasks/${id}/status`, { status, actor: agent }, `status changed to ${status}`);
  };

  const reopen = (status: "todo" | "ready") => {
    if (!id) return;
    void run(`/api/tasks/${id}/reopen`, { status, actor: agent }, `reopened as ${status}`);
  };

  const save = async () => {
    if (!id) return;
    const result = await api<TaskData>(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, priority, description, notes, actor: agent }),
    });
    if (!result.ok) {
      setCommandError(firstError(result));
      setMessage("");
      return;
    }
    setCommandError(null);
    setMessage("task details updated");
    load();
  };

  const [copied, setCopied] = useState(false);
  if (loading) return <Placeholder>Loading…</Placeholder>;
  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!task) return <Placeholder>Task not found.</Placeholder>;

  const copyPrompt = () => {
    const text = [
      `# ${task.id} — ${task.title}`,
      task.description ? `\n${task.description}` : "",
      task.acceptance?.length
        ? `\n## Acceptance\n${task.acceptance.map((item) => `- ${item}`).join("\n")}`
        : "",
      brief ? `\n## Next action\n${brief.nextAction}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const meta = STATUS_META[task.status]!;
  const claimReason = claimDisabledReason(task.readiness, agent);
  const terminal = task.status === "done" || task.status === "wont_do";
  const activeClaimMismatch = brief?.activeClaim && brief.activeClaim.agent !== agent;

  return (
    <div>
      <DiagnosticBanner error={commandError} />
      {message && <div style={{ color: "var(--green)", marginBottom: 12 }}>{message}</div>}

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "11.5px", fontFamily: "var(--mono)", color: "var(--text-dim)", marginBottom: 8 }}>
            {task.id}
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>{task.title}</div>

          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <span className="badge" style={{ background: meta.bg, color: meta.fg }}>
              Declared: {meta.label}
            </span>
            <span className="badge" style={{ background: "var(--bg-hover)", color: "var(--text-muted)" }}>
              Readiness: {task.readiness.state}
            </span>
            <span className="badge" style={{ background: "var(--bg-hover)", color: "var(--text-muted)" }}>
              P{task.priority}
            </span>
            {task.scope && <span className="badge">{task.scope}</span>}
          </div>
          {task.readiness.blockers.length > 0 && (
            <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 12 }}>
              Blockers: {task.readiness.blockers.join(", ")}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
            <button className="btn-primary" onClick={() => taskAction("claim")} disabled={Boolean(claimReason)} title={claimReason ?? undefined}>
              Claim task
            </button>
            <button className="btn-secondary" onClick={() => taskAction("release")} disabled={task.status !== "in_progress" || !brief?.activeClaim || Boolean(activeClaimMismatch)} title={activeClaimMismatch ? `Claim belongs to ${brief?.activeClaim?.agent}` : undefined}>
              Release
            </button>
            <button className="btn-outline" onClick={() => taskAction("finish")} disabled={terminal || Boolean(activeClaimMismatch)} title={terminal ? "Terminal tasks cannot be finished." : activeClaimMismatch ? `Claim belongs to ${brief?.activeClaim?.agent}` : undefined}>
              Finish
            </button>
            <input className="input" value={agent} onChange={(event) => setAgent(event.target.value)} placeholder="agent" style={{ width: 120, padding: "9px 12px" }} />
            <button className="btn-outline" onClick={copyPrompt}>{copied ? "Copied!" : "Copy prompt"}</button>
          </div>

          <div className="panel" style={{ padding: 16, marginBottom: 18 }}>
            <div className="section-label">Lifecycle</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {STATUS_TRANSITIONS[task.status].map((status) => {
                const blockedByClaim = Boolean(brief?.activeClaim);
                return (
                  <button key={status} className="btn-outline" onClick={() => setStatus(status)} disabled={blockedByClaim} title={blockedByClaim ? "Release or finish the active claim first." : undefined}>
                    Set {STATUS_META[status]?.label ?? status}
                  </button>
                );
              })}
              {terminal && (
                <>
                  <button className="btn-outline" onClick={() => reopen("todo")}>Reopen as Todo</button>
                  <button className="btn-outline" onClick={() => reopen("ready")}>Reopen as Ready</button>
                </>
              )}
              {STATUS_TRANSITIONS[task.status].length === 0 && !terminal && (
                <span style={{ color: "var(--text-dim)", fontSize: 12 }}>No direct status transitions are available.</span>
              )}
            </div>
          </div>

          <div className="panel" style={{ padding: 16, marginBottom: 18 }}>
            <div className="section-label">Edit task</div>
            <div style={{ display: "grid", gap: 10 }}>
              <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" />
              <input className="input" type="number" min={0} value={priority} onChange={(event) => setPriority(Number(event.target.value))} placeholder="Priority" />
              <textarea className="input" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" rows={4} />
              <textarea className="input" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" rows={3} />
              <button className="btn-primary" onClick={save} disabled={!title.trim()}>Save details</button>
            </div>
          </div>

          {task.acceptance && task.acceptance.length > 0 && (
            <>
              <div className="section-label">Acceptance</div>
              {task.acceptance.map((item) => <div key={item} style={{ color: "var(--text-secondary)", marginBottom: 6 }}>✓ {item}</div>)}
            </>
          )}
          {brief && (
            <div style={{ borderLeft: "2px solid var(--green)", paddingLeft: 16, marginTop: 20 }}>
              <div className="section-label">Next action</div>
              <div>{brief.nextAction}</div>
            </div>
          )}
        </div>

        <div className="detail-panel" style={{ maxWidth: 340 }}>
          <div className="section-label">Selected ledger root</div>
          <div style={{ fontSize: "11.5px", fontFamily: "var(--mono)", overflowWrap: "anywhere", color: "var(--text-muted)" }}>
            {task.ledgerRoot}
          </div>
          {brief?.activeClaim && (
            <>
              <div className="section-label" style={{ marginTop: 18 }}>Active claim</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{brief.activeClaim.agent}</div>
              <div style={{ fontSize: "11.5px", fontFamily: "var(--mono)", color: "var(--text-dim)", marginTop: 4 }}>{brief.activeClaim.id}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
