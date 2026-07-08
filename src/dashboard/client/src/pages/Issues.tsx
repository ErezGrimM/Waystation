import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useLedgerEvents } from "../events.tsx";

interface IssueItem {
  id: string;
  title: string;
  status: string;
  severity?: string;
  type?: string;
  task?: string | null;
  description?: string;
  created_at?: string;
}

const ISSUE_FILTERS = ["all", "open", "triaged", "in_progress", "fixed", "verified", "closed"];

const SEVERITY_META: Record<string, { bg: string; fg: string }> = {
  low: { bg: "var(--bg-hover)", fg: "var(--text-muted)" },
  medium: { bg: "rgba(245,166,35,0.14)", fg: "var(--orange)" },
  high: { bg: "rgba(255,138,61,0.14)", fg: "#ff8a3d" },
  critical: { bg: "rgba(239,83,80,0.14)", fg: "var(--red)" },
};

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  open: { label: "Open", bg: "rgba(239,83,80,0.14)", fg: "var(--red)" },
  triaged: { label: "Triaged", bg: "rgba(245,166,35,0.14)", fg: "var(--orange)" },
  in_progress: { label: "In Progress", bg: "rgba(245,166,35,0.14)", fg: "var(--orange)" },
  fixed: { label: "Fixed", bg: "rgba(52,199,123,0.14)", fg: "var(--green)" },
  verified: { label: "Verified", bg: "rgba(52,199,123,0.14)", fg: "var(--green)" },
  closed: { label: "Closed", bg: "var(--bg-hover)", fg: "var(--text-dim)" },
};

type SortKey = "created_at" | "title" | "severity";

export function Issues() {
  const [issues, setIssues] = useState<IssueItem[]>([]);
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<SortKey>("created_at");
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("");
  const [type, setType] = useState("");
  const [msg, setMsg] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [repo, setRepo] = useState("");
  const [loading, setLoading] = useState(false);
  const { revision } = useLedgerEvents();

  const load = () => {
    api<IssueItem[]>("/api/issues").then((r) => {
      if (r.ok && r.data) setIssues(r.data);
    });
  };

  useEffect(load, [revision]);

  let filtered = issues;
  if (filter !== "all") filtered = issues.filter((i) => i.status === filter);
  filtered = [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case "title":
        cmp = a.title.localeCompare(b.title);
        break;
      case "severity":
        cmp = (a.severity ?? "").localeCompare(b.severity ?? "");
        break;
      default:
        cmp = (a.created_at ?? "").localeCompare(b.created_at ?? "");
    }
    if (cmp === 0) cmp = a.id.localeCompare(b.id);
    return order === "asc" ? cmp : -cmp;
  });

  const toggleSort = (key: SortKey) => {
    if (sort === key) setOrder((o) => (o === "desc" ? "asc" : "desc"));
    else { setSort(key); setOrder("desc"); }
  };

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

  const doImport = async () => {
    if (!repo) return;
    setLoading(true);
    const r = await api<{ imported: number; ids: string[] }>("/api/gh/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo }),
    });
    setLoading(false);
    if (r.ok && r.data) {
      setMsg(`Imported ${r.data.imported} issues from GitHub`);
      setShowImport(false);
      setRepo("");
      load();
    } else {
      setMsg(r.errors?.[0]?.message ?? "Import failed");
    }
  };

  const doExport = async () => {
    if (!repo) return;
    setLoading(true);
    const r = await api<{ exported: number; ids: string[] }>("/api/gh/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo }),
    });
    setLoading(false);
    if (r.ok && r.data) {
      setMsg(`Exported ${r.data.exported} issues to GitHub`);
      setShowExport(false);
      setRepo("");
    } else {
      setMsg(r.errors?.[0]?.message ?? "Export failed");
    }
  };

  return (
    <div>
      <h1>Issues</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button className="btn-secondary" onClick={() => setShowImport(true)}>
          Import from GitHub
        </button>
        <button className="btn-secondary" onClick={() => setShowExport(true)}>
          Export to GitHub
        </button>
      </div>

      {showImport && (
        <div className="panel" style={{ marginBottom: 16, padding: 16 }}>
          <div className="panel-header">Import from GitHub</div>
          <div className="panel-body">
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                className="input"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/repo"
                style={{ flex: 1 }}
              />
              <button className="btn-primary" onClick={doImport} disabled={loading}>
                {loading ? "Importing..." : "Import"}
              </button>
              <button className="btn-outline" onClick={() => { setShowImport(false); setRepo(""); }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showExport && (
        <div className="panel" style={{ marginBottom: 16, padding: 16 }}>
          <div className="panel-header">Export to GitHub</div>
          <div className="panel-body">
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                className="input"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/repo"
                style={{ flex: 1 }}
              />
              <button className="btn-primary" onClick={doExport} disabled={loading}>
                {loading ? "Exporting..." : "Export"}
              </button>
              <button className="btn-outline" onClick={() => { setShowExport(false); setRepo(""); }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="filter-chips">
        {ISSUE_FILTERS.map((f) => {
          const meta = STATUS_META[f];
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

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="title" style={{ flex: 1 }} />
        <input className="input" value={type} onChange={(e) => setType(e.target.value)} placeholder="type" style={{ width: 100 }} />
        <input className="input" value={severity} onChange={(e) => setSeverity(e.target.value)} placeholder="severity" style={{ width: 100 }} />
        <button className="btn-primary" onClick={create}>
          Create
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {(
          [
            ["created_at", "Created"],
            ["severity", "Severity"],
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
      </div>

      {msg && <div style={{ color: msg === "created" || msg.includes("Imported") || msg.includes("Exported") ? "var(--green)" : "var(--red)", marginBottom: 12 }}>{msg}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.map((i) => {
          const sm = SEVERITY_META[i.severity ?? ""] ?? { bg: "var(--bg-hover)", fg: "var(--text-muted)" };
          const st = STATUS_META[i.status] ?? { label: i.status, bg: "var(--bg-hover)", fg: "var(--text-muted)" };
          return (
            <div key={i.id} className="issue-card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{i.title}</div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <span className="badge" style={{ background: sm.bg, color: sm.fg }}>
                    {i.severity ?? "-"}
                  </span>
                  <span className="badge" style={{ background: st.bg, color: st.fg }}>
                    {st.label ?? i.status}
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
        {filtered.length === 0 && (
          <div style={{ color: "var(--text-dim)", padding: 40, textAlign: "center" }}>No issues match this filter.</div>
        )}
      </div>
    </div>
  );
}
