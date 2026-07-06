import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";

interface TaskBrief {
  id: string;
  title: string;
  status: string;
  priority: number;
}
interface StatusData {
  total: number;
  counts: Record<string, number>;
  next: TaskBrief | null;
}

const STATUS_COLORS: Record<string, string> = {
  ready: "var(--accent)",
  in_progress: "var(--orange)",
  blocked: "var(--red)",
  review: "var(--purple)",
  done: "var(--green)",
};

export function Dashboard() {
  const [data, setData] = useState<StatusData | null>(null);

  useEffect(() => {
    api<StatusData>("/api/status").then((r) => {
      if (r.ok) setData(r.data);
    });
  }, []);

  if (!data) return <div>Loading...</div>;

  const statCards = [
    { label: "Ready", value: data.counts.ready ?? 0, color: STATUS_COLORS.ready },
    { label: "In progress", value: data.counts.in_progress ?? 0, color: STATUS_COLORS.in_progress },
    { label: "Blocked", value: data.counts.blocked ?? 0, color: STATUS_COLORS.blocked },
    { label: "Review", value: data.counts.review ?? 0, color: STATUS_COLORS.review },
    { label: "Done", value: data.counts.done ?? 0, color: STATUS_COLORS.done },
  ];

  return (
    <div>
      <div className="stat-grid">
        {statCards.map((s) => (
          <div key={s.label} className="stat-card">
            <div className="stat-value" style={{ color: s.color }}>
              {s.value}
            </div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {data.next && (
        <div className="panel" style={{ marginBottom: 26, padding: 20 }}>
          <div className="panel-header">Next task</div>
          <div className="panel-body">
            <Link to={`/tasks/${data.next.id}`} style={{ fontWeight: 600 }}>
              {data.next.id}
            </Link>{" "}
            <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
              [p{data.next.priority}] {data.next.title}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
