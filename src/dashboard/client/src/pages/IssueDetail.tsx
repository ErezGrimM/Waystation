import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type CommandDiagnostic, firstError } from "../api.ts";
import { DiagnosticBanner, ErrorBanner, Placeholder } from "../components.tsx";

interface IssueData {
  id: string;
  title: string;
  status: string;
  severity?: string;
  type?: string;
  priority?: number;
  task?: string | null;
  scope?: string | null;
  description?: string;
  evidence?: unknown;
  expected?: string;
  actual?: string;
  acceptance?: string[];
  resolution?: string;
  notes?: string;
  source?: unknown;
  ledgerRoot: string;
}

export function IssueDetail() {
  const { id } = useParams<{ id: string }>();
  const [issue, setIssue] = useState<IssueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<CommandDiagnostic | null>(null);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [type, setType] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [resolution, setResolution] = useState("");

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    api<IssueData>(`/api/issues/${id}`).then((result) => {
      if (result.ok && result.data) {
        setIssue(result.data);
        setTitle(result.data.title);
        setStatus(result.data.status);
        setSeverity(result.data.severity ?? "");
        setType(result.data.type ?? "");
        setDescription(result.data.description ?? "");
        setNotes(result.data.notes ?? "");
        setResolution(result.data.resolution ?? "");
        setLoadError(null);
      } else {
        setLoadError(firstError(result, "Failed to load issue").message);
      }
      setLoading(false);
    });
  }, [id]);

  useEffect(() => load(), [load]);

  const save = async () => {
    if (!id) return;
    const result = await api(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, status, severity, type, description, notes, actor: "dashboard" }),
    });
    if (!result.ok) {
      setCommandError(firstError(result));
      setMessage("");
      return;
    }
    setCommandError(null);
    setMessage("issue details updated");
    load();
  };

  const close = async () => {
    if (!id) return;
    const result = await api(`/api/issues/${id}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution, actor: "dashboard" }),
    });
    if (!result.ok) {
      setCommandError(firstError(result));
      setMessage("");
      return;
    }
    setCommandError(null);
    setMessage("issue closed");
    load();
  };

  if (loading) return <Placeholder>Loading…</Placeholder>;
  if (loadError) return <ErrorBanner message={loadError} onRetry={load} />;
  if (!issue) return <Placeholder>Issue not found.</Placeholder>;

  return (
    <div>
      <DiagnosticBanner error={commandError} />
      {message && <div style={{ color: "var(--green)", marginBottom: 12 }}>{message}</div>}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)" }}>{issue.id}</div>
          <h1>{issue.title}</h1>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
            <span className="badge">Declared: {issue.status}</span>
            {issue.severity && <span className="badge">Severity: {issue.severity}</span>}
            {issue.type && <span className="badge">Type: {issue.type}</span>}
            {issue.scope && <span className="badge">{issue.scope}</span>}
          </div>

          <div className="panel" style={{ padding: 16, marginBottom: 18 }}>
            <div className="section-label">Edit issue</div>
            <div style={{ display: "grid", gap: 10 }}>
              <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                <input className="input" value={status} onChange={(event) => setStatus(event.target.value)} placeholder="Status" />
                <input className="input" value={severity} onChange={(event) => setSeverity(event.target.value)} placeholder="Severity" />
                <input className="input" value={type} onChange={(event) => setType(event.target.value)} placeholder="Type" />
              </div>
              <textarea className="input" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" />
              <textarea className="input" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" />
              <button className="btn-primary" onClick={save} disabled={!title.trim() || !status.trim()}>Save details</button>
            </div>
          </div>

          <div className="panel" style={{ padding: 16, marginBottom: 18 }}>
            <div className="section-label">Close issue</div>
            <textarea className="input" rows={3} value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="Resolution" style={{ width: "100%", marginBottom: 8 }} />
            <button className="btn-outline" onClick={close} disabled={issue.status === "closed" || !resolution.trim()} title={issue.status === "closed" ? "This issue is already closed." : !resolution.trim() ? "Enter a resolution before closing." : undefined}>
              Close issue
            </button>
          </div>

          <div className="section-label">Preserved context</div>
          {issue.description && <Context label="Description" value={issue.description} />}
          {issue.expected && <Context label="Expected" value={issue.expected} />}
          {issue.actual && <Context label="Actual" value={issue.actual} />}
          {issue.evidence !== undefined && <Context label="Evidence" value={formatUnknown(issue.evidence)} />}
          {issue.acceptance?.length ? <Context label="Acceptance" value={issue.acceptance.map((item) => `• ${item}`).join("\n")} /> : null}
          {issue.resolution && <Context label="Resolution" value={issue.resolution} />}
          {issue.notes && <Context label="Notes" value={issue.notes} />}
          {issue.source !== undefined && <Context label="Source" value={formatUnknown(issue.source)} />}
        </div>

        <div className="detail-panel" style={{ maxWidth: 340 }}>
          <div className="section-label">Selected ledger root</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, overflowWrap: "anywhere", color: "var(--text-muted)" }}>{issue.ledgerRoot}</div>
          {issue.task && (
            <>
              <div className="section-label" style={{ marginTop: 18 }}>Linked task</div>
              <Link to={`/tasks/${issue.task}`}>{issue.task}</Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatUnknown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function Context({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ whiteSpace: "pre-wrap", color: "var(--text-secondary)", lineHeight: 1.5 }}>{value}</div>
    </div>
  );
}
