import { useEffect, useState } from "react";
import { api } from "../api.ts";

interface ClaimItem {
  id: string;
  task: string;
  agent: string;
  status: string;
  branch?: string | null;
  claimed_at: string;
}

interface TaskItem {
  id: string;
  title: string;
}

export function Claims() {
  const [claims, setClaims] = useState<ClaimItem[]>([]);
  const [tasks, setTasks] = useState<Map<string, TaskItem>>(new Map());
  const [msg, setMsg] = useState("");

  const load = () => {
    api<TaskItem[]>("/api/tasks?status=in_progress").then((r) => {
      if (r.ok && r.data) {
        const map = new Map<string, TaskItem>();
        for (const t of r.data) map.set(t.id, t);
        setTasks(map);
      }
    });
    // Load claims from all tasks via polling all in-progress
    api<TaskItem[]>("/api/tasks").then((r) => {
      if (r.ok && r.data) {
        const map = new Map<string, TaskItem>();
        for (const t of r.data) map.set(t.id, t);
        setTasks(map);
      }
    });
  };

  useEffect(() => {
    load();
  }, []);

  const releaseTask = async (taskId: string) => {
    const r = await api(`/api/tasks/${taskId}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "opencode" }),
    });
    setMsg(r.ok ? "released" : r.errors?.[0]?.message ?? "error");
    if (r.ok) load();
  };

  // Show in-progress tasks as "claims"
  const inProgressTasks = Array.from(tasks.values()).filter((t) => {
    return true; // We don't have full claim data from the API easily, show all in_progress
  });

  // Get claim data from tasks API (brief includes activeClaim)
  useEffect(() => {
    const loadClaims = async () => {
      const all = new Map<string, ClaimItem>();
      for (const t of tasks.values()) {
        const r = await api<{ activeClaim: ClaimItem | null }>(`/api/tasks/${t.id}/brief`);
        if (r.ok && r.data?.activeClaim) {
          all.set(t.id, {
            ...r.data.activeClaim,
            task: t.id,
          });
        }
      }
      setClaims(Array.from(all.values()));
    };
    if (tasks.size > 0) loadClaims();
  }, [tasks.size]);

  return (
    <div>
      <h1>Claims</h1>
      {msg && <div style={{ color: msg === "released" ? "var(--green)" : "var(--red)", marginBottom: 12 }}>{msg}</div>}

      {claims.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {claims.map((c) => {
            const t = tasks.get(c.task);
            return (
              <div key={c.id} className="issue-card" style={{ display: "flex", alignItems: "center", gap: 18 }}>
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    background: "var(--bg-hover)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--text-secondary)",
                    flexShrink: 0,
                  }}
                >
                  {c.agent.slice(0, 1).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "13.5px", fontWeight: 600 }}>{t?.title ?? c.task}</div>
                  <div style={{ fontSize: "11.5px", fontFamily: "var(--mono)", color: "var(--text-dim)", marginTop: 2 }}>
                    {c.agent} · {c.branch ?? "—"} · {c.claimed_at}
                  </div>
                </div>
                <button className="btn-secondary" onClick={() => releaseTask(c.task)}>
                  Release
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ color: "var(--text-dim)", padding: 40, textAlign: "center" }}>
          No active claims right now.
        </div>
      )}
    </div>
  );
}
