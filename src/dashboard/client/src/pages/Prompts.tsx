import { useEffect, useState } from "react";
import { api } from "../api.ts";

interface PromptItem {
  id: string;
  title: string;
  status: string;
  version: number;
  priority: number;
}

interface RenderResult {
  prompts: string[];
  rendered: string;
}

export function Prompts() {
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [task, setTask] = useState("");
  const [agent, setAgent] = useState("opencode");
  const [role, setRole] = useState("");
  const [rendered, setRendered] = useState("");

  useEffect(() => {
    api<PromptItem[]>("/api/prompts").then((r) => {
      if (r.ok && r.data) setPrompts(r.data);
    });
  }, []);

  const render = async () => {
    if (!task || !agent) return;
    const qs = new URLSearchParams({ task, agent });
    if (role) qs.set("role", role);
    const r = await api<RenderResult>(`/api/prompts/render?${qs}`);
    if (r.ok && r.data) setRendered(r.data.rendered);
    else setRendered(r.errors?.[0]?.message ?? "error");
  };

  return (
    <div>
      <h1>Prompts</h1>

      <div style={{ marginBottom: "0.75rem", display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="task id" style={{ padding: "0.3rem", width: 180 }} />
        <input value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="agent" style={{ padding: "0.3rem", width: 120 }} />
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="role" style={{ padding: "0.3rem", width: 120 }} />
        <button onClick={render} style={{ padding: "0.35rem 0.75rem" }}>
          Render
        </button>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1.5rem" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
            <th style={{ padding: "0.4rem" }}>ID</th>
            <th style={{ padding: "0.4rem" }}>Title</th>
            <th style={{ padding: "0.4rem" }}>Status</th>
            <th style={{ padding: "0.4rem" }}>Version</th>
            <th style={{ padding: "0.4rem" }}>Priority</th>
          </tr>
        </thead>
        <tbody>
          {prompts.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "0.4rem" }}>{p.id}</td>
              <td style={{ padding: "0.4rem" }}>{p.title}</td>
              <td style={{ padding: "0.4rem" }}>{p.status}</td>
              <td style={{ padding: "0.4rem" }}>v{p.version}</td>
              <td style={{ padding: "0.4rem" }}>p{p.priority}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {rendered && (
        <div style={{ background: "#f9f9f9", border: "1px solid #ddd", borderRadius: 6, padding: "1rem" }}>
          <h3>Rendered Output</h3>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "0.85rem" }}>
            {rendered}
          </pre>
        </div>
      )}
    </div>
  );
}
