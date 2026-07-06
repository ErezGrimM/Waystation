import { useEffect, useState } from "react";
import { api } from "../api.ts";

interface IssueItem {
  id: string;
  title: string;
  status: string;
  severity?: string;
  type?: string;
  task?: string | null;
  description?: string;
}

const SEVERITY_META: Record<string, { bg: string; fg: string }> = {
  low: { bg: "var(--bg-hover)", fg: "var(--text-muted)" },
  medium: { bg: "rgba(245,166,35,0.14)", fg: "var(--orange)" },
  high: { bg: "rgba(255,138,61,0.14)", fg: "#ff8a3d" },
  critical: { bg: "rgba(239,83,80,0.14)", fg: "var(--red)" },
};

const STATUS_META: Record<string, { bg: string; fg: string }> = {
  open: { bg: "rgba(239,83,80,0.14)", fg: "var(--red)" },
  triaged: { bg: "rgba(245,166,35,0.14)", fg: "var(--orange)" },
  in_progress: { bg: "rgba(245,166,35,0.14)", fg: "var(--orange)" },
  fixed: { bg: "rgba(52,199,123,0.14)", fg: "var(--green)" },
  verified: { bg: "rgba(52,199,123,0.14)", fg: "var(--green)" },
  closed: { bg: "var(--bg-hover)", fg: "var(--text-dim)" },
};

export function Issues() {
  const [issues, setIssues] = useState<IssueItem[]>([]);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("");
  const [type, setType] = useState("");
  const [msg, setMsg] = useState("");

  const load = () => {
    api<IssueItem[]>("/api/issues").then((r) => {
      if (r.ok && r.data) setIssues(r.data);
    });
  };

  useEffect(load, []);

  const create = async () => {
    if (!title) return;
    const r = await api("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, severity: severity || undefined, type: type || undefined }),
    });
    setMsg(r.ok ? "created" : r.errors?.[0]?.message ?? "error");
    if (r.ok) {
      setTitle("");
      setSeverity("");
      setType("");
      load();
    }
  };

  return (
    <div>
      <h1>Issues</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="title" style={{ flex: 1 }} />
        <input className="input" value={type} onChange={(e) => setType(e.target.value)} placeholder="type" style={{ width: 100 }} />
        <input className="input" value={severity} onChange={(e) => setSeverity(e.target.value)} placeholder="severity" style={{ width: 100 }} />
        <button className="btn-primary" onClick={create}>
          Create
        </button>
      </div>
      {msg && <div style={{ color: msg === "created" ? "var(--green)" : "var(--red)", marginBottom: 12 }}>{msg}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {issues.map((i) => {
          const sm = SEVERITY_META[i.severity ?? ""] ?? { bg: "var(--bg-hover)", fg: "var(--text-muted)" };
          const st = STATUS_META[i.status] ?? { bg: "var(--bg-hover)", fg: "var(--text-muted)" };
          return (
            <div key={i.id} className="issue-card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{i.title}</div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <span className="badge" style={{ background: sm.bg, color: sm.fg }}>
                    {i.severity ?? "-"}
                  </span>
                  <span className="badge" style={{ background: st.bg, color: st.fg }}>
                    {i.status}
                  </span>
                </div>
              </div>
              <div style={{ fontSize: "11.5px", fontFamily: "var(--mono)", color: "var(--text-dim)", marginBottom: 10 }}>
                {i.id} · {i.task ?? "no linked task"}
              </div>
              {i.description && (
                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>
                  {i.description}
                </div>
              )}
            </div>
          );
        })}
        {issues.length === 0 && (
          <div style={{ color: "var(--text-dim)", padding: 40, textAlign: "center" }}>No issues.</div>
        )}
      </div>
    </div>
  );
}
