import { useEffect, useState } from "react";
import { api } from "../api.ts";

interface GitFile {
  status: string;
  file: string;
}

interface GitStatus {
  changed: number;
  untracked: number;
  files: GitFile[];
}

export function Git() {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [staged, setStaged] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [result, setResult] = useState("");

  const load = () => {
    api<GitStatus>("/api/git/status").then((r) => {
      if (r.ok && r.data) setStatus(r.data);
    });
    api<{ diff: string | null; staged: string | null }>("/api/git/diff").then((r) => {
      if (r.ok && r.data) {
        setDiff(r.data.diff);
        setStaged(r.data.staged);
      }
    });
  };

  useEffect(load, []);

  const toggleFile = (file: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  const selectAll = () => {
    if (!status) return;
    setSelectedFiles(new Set(status.files.map((f) => f.file)));
  };

  const commit = async () => {
    if (!message) return;
    const body: { message: string; files?: string[] } = { message };
    if (selectedFiles.size > 0) body.files = Array.from(selectedFiles);
    const r = await api<{ output: string }>("/api/git/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      setResult(`Committed: ${r.data?.output ?? "ok"}`);
      setMessage("");
      setSelectedFiles(new Set());
      load();
    } else {
      setResult(`Error: ${r.errors?.[0]?.message ?? "commit failed"}`);
    }
  };

  const statusLabel = (s: string) => {
    if (s.startsWith("M") || s.includes("M")) return "Modified";
    if (s.startsWith("A") || s.includes("A")) return "Added";
    if (s.startsWith("D") || s.includes("D")) return "Deleted";
    if (s.startsWith("R") || s.includes("R")) return "Renamed";
    if (s.startsWith("??")) return "Untracked";
    return s;
  };

  const statusColor = (s: string) => {
    if (s.includes("M")) return "var(--orange)";
    if (s.includes("A")) return "var(--green)";
    if (s.includes("D")) return "var(--red)";
    if (s.includes("R")) return "var(--purple)";
    return "var(--text-dim)";
  };

  return (
    <div>
      <h1>Git</h1>

      {!status && <div>Loading...</div>}

      {status && (
        <>
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
            <div className="stat-card">
              <div className="stat-value" style={{ color: "var(--orange)" }}>
                {status.changed}
              </div>
              <div className="stat-label">Changed</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: "var(--text-dim)" }}>
                {status.untracked}
              </div>
              <div className="stat-label">Untracked</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ color: "var(--accent)" }}>
                {status.files.length}
              </div>
              <div className="stat-label">Total files</div>
            </div>
          </div>

          {status.files.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
                <div className="section-label" style={{ marginBottom: 0 }}>
                  Files
                </div>
                <button className="chip" onClick={selectAll} style={{ cursor: "pointer" }}>
                  Select all
                </button>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {selectedFiles.size} selected
                </span>
              </div>

              {status.files.map((f) => (
                <div
                  key={f.file}
                  className="task-row"
                  onClick={() => toggleFile(f.file)}
                  style={{
                    borderColor: selectedFiles.has(f.file) ? "var(--accent)" : undefined,
                  }}
                >
                  <span
                    className="badge"
                    style={{
                      background: `color-mix(in srgb, ${statusColor(f.status)} 14%, transparent)`,
                      color: statusColor(f.status),
                      width: 78,
                    }}
                  >
                    {statusLabel(f.status)}
                  </span>
                  <div style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 12 }}>
                    {f.file}
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: selectedFiles.has(f.file) ? "var(--accent)" : "var(--text-dim)",
                    }}
                  >
                    {selectedFiles.has(f.file) ? "✓ staged" : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {status.files.length === 0 && (
            <div style={{ color: "var(--text-dim)", padding: 20, textAlign: "center" }}>
              Working tree clean.
            </div>
          )}

          {(diff || staged) && (
            <div className="panel" style={{ marginBottom: 20 }}>
              <div className="panel-header">Changes</div>
              <div className="panel-body">
                {staged && (
                  <div>
                    <div className="section-label">Staged</div>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        color: "var(--text-secondary)",
                        margin: 0,
                      }}
                    >
                      {staged}
                    </pre>
                  </div>
                )}
                {diff && (
                  <div style={{ marginTop: staged ? 16 : 0 }}>
                    <div className="section-label">Unstaged</div>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        color: "var(--text-secondary)",
                        margin: 0,
                      }}
                    >
                      {diff}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}

          {status.files.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                className="input"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Commit message"
                style={{ flex: 1 }}
              />
              <button className="btn-primary" onClick={commit}>
                Commit
              </button>
            </div>
          )}

          {result && (
            <div
              style={{
                marginTop: 12,
                color: result.startsWith("Error") ? "var(--red)" : "var(--green)",
              }}
            >
              {result}
            </div>
          )}
        </>
      )}
    </div>
  );
}
