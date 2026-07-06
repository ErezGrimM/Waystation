import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api.ts";

interface TaskItem {
  id: string;
  title: string;
  status: string;
  priority: number;
  scope?: string | null;
  created_at?: string;
  updated_at?: string;
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

const FILTERS = ["all", "ready", "in_progress", "blocked", "review", "done"];

type SortKey = "created_at" | "priority" | "title" | "updated_at";

export function Tasks() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") ?? "all";
  const [sort, setSort] = useState<SortKey>("created_at");
  const [order, setOrder] = useState<"desc" | "asc">("desc");

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    params.set("sort", sort);
    params.set("order", order);
    api<TaskItem[]>(`/api/tasks?${params}`).then((r) => {
      if (r.ok && r.data) setTasks(r.data);
    });
  }, [status, sort, order]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleSort = (key: SortKey) => {
    if (sort === key) {
      setOrder((o) => (o === "desc" ? "asc" : "desc"));
    } else {
      setSort(key);
      setOrder("desc");
    }
  };

  return (
    <div>
      <h1>Tasks</h1>

      <div className="filter-chips">
        {FILTERS.map((f) => {
          const meta = STATUS_META[f];
          return (
            <button
              key={f}
              className={`chip${status === f ? " active" : ""}`}
              onClick={() => setSearchParams(f === "all" ? {} : { status: f })}
            >
              {f === "all" ? "All" : meta!.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {(
          [
            ["created_at", "Created"],
            ["updated_at", "Updated"],
            ["priority", "Priority"],
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

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tasks.map((t) => {
          const meta = STATUS_META[t.status] ?? { label: t.status, bg: "#1c2430", fg: "#8b98a9" };
          return (
            <Link key={t.id} to={`/tasks/${t.id}`} style={{ textDecoration: "none" }}>
              <div className="task-row">
                <span className="badge" style={{ background: meta!.bg, color: meta!.fg, width: 78 }}>
                  {meta!.label}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "13.5px", fontWeight: 600, color: "var(--text)" }}>
                    {t.title}
                  </div>
                  <div style={{ fontSize: "11.5px", fontFamily: "var(--mono)", color: "var(--text-dim)", marginTop: 2 }}>
                    {t.id} · {t.scope ?? "-"} · {t.created_at ?? ""}
                  </div>
                </div>
                <span className="badge" style={{ background: "var(--bg-hover)", color: "var(--text-muted)" }}>
                  P{t.priority}
                </span>
              </div>
            </Link>
          );
        })}
        {tasks.length === 0 && (
          <div style={{ color: "var(--text-dim)", padding: 40, textAlign: "center" }}>
            No tasks match this filter.
          </div>
        )}
      </div>
    </div>
  );
}
