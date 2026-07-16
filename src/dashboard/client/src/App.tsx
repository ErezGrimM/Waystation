import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { Dashboard } from "./pages/Dashboard.tsx";
import { GraphView } from "./pages/GraphView.tsx";
import { Tasks } from "./pages/Tasks.tsx";
import { TaskDetail } from "./pages/TaskDetail.tsx";
import { Issues } from "./pages/Issues.tsx";
import { IssueDetail } from "./pages/IssueDetail.tsx";
import { Claims } from "./pages/Claims.tsx";
import { Git } from "./pages/Git.tsx";
import { Messages } from "./pages/Messages.tsx";
import { Brief } from "./pages/Brief.tsx";

const VIEWS: Record<string, [string, string]> = {
  "/": ["Overview", "Status across the whole ledger"],
  "/tasks": ["Tasks", "Ready, in-progress, and blocked work"],
  "/tasks/detail": ["Task detail", ""],
  "/issues": ["Issues", "Bugs, blockers, and review findings"],
  "/issues/detail": ["Issue detail", "Lifecycle and preserved issue context"],
  "/claims": ["Claims", "Who is working on what, right now"],
  "/messages": ["Messages", "Shared async inbox — project and task threads"],
  "/git": ["Git", "Status, diff, and commit"],
  "/graph": ["Graph", "Codebase knowledge graph"],
  "/brief": ["Brief", "Task-scoped context package for an agent"],
};

export function App() {
  const location = useLocation();
  const path = location.pathname.startsWith("/tasks/")
    ? "/tasks/detail"
    : location.pathname.startsWith("/issues/")
      ? "/issues/detail"
      : location.pathname;
  const [title, subtitle] = VIEWS[path] ?? ["", ""];
  const [reindexMsg, setReindexMsg] = useState("");

  const doReindex = useCallback(async () => {
    setReindexMsg("Reindexing...");
    const r = await api<{ tasks: number; issues: number; claims: number; messages: number }>(
      "/api/reindex",
      { method: "POST" },
    );
    if (r.ok && r.data) {
      setReindexMsg(
        `Done: ${r.data.tasks} tasks, ${r.data.issues} issues, ${r.data.claims} claims, ${r.data.messages} msgs`,
      );
    } else {
      setReindexMsg(r.errors?.[0]?.message ?? "Failed");
    }
    setTimeout(() => setReindexMsg(""), 4000);
  }, []);

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">W</div>
          <div>
            <div className="sidebar-title">Waystation</div>
            <div className="sidebar-subtitle">local-first ledger</div>
          </div>
        </div>

        <div className="sidebar-nav">
          {[
            ["/", "Overview"],
            ["/tasks", "Tasks"],
            ["/issues", "Issues"],
            ["/claims", "Claims"],
            ["/messages", "Messages"],
            ["/git", "Git"],
            ["/graph", "Graph"],
            ["/brief", "Brief"],
          ].map(([to, label]) => (
            <NavLink
              key={to!}
              to={to!}
              end={to === "/"}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
            >
              {label}
            </NavLink>
          ))}
        </div>

        <div className="sidebar-footer">
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-dim)" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--green)", flexShrink: 0 }} />
            local-first · no server
          </div>
        </div>
      </nav>

      <div className="main">
        <div className="topbar">
          <div>
            <div className="topbar-title">{title}</div>
            {subtitle && <div className="topbar-subtitle">{subtitle}</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {reindexMsg && (
              <span style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>
                {reindexMsg}
              </span>
            )}
            <button className="btn-secondary" onClick={doReindex}>
              Reindex
            </button>
          </div>
        </div>

        <div className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/tasks/:id" element={<TaskDetail />} />
            <Route path="/issues" element={<Issues />} />
            <Route path="/issues/:id" element={<IssueDetail />} />
            <Route path="/claims" element={<Claims />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/git" element={<Git />} />
            <Route path="/graph" element={<GraphView />} />
            <Route path="/brief" element={<Brief />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
