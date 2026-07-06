import { useEffect, useState } from "react";
import { api } from "../api.ts";

interface MessageItem {
  id: string;
  thread: string;
  from_agent: string;
  to_agent?: string | null;
  kind: string;
  body: string;
  created_at: string;
}

const KIND_META: Record<string, { label: string; bg: string; fg: string }> = {
  update: { label: "Update", bg: "rgba(79,140,255,0.14)", fg: "var(--accent)" },
  question: { label: "Question", bg: "rgba(167,139,250,0.14)", fg: "var(--purple)" },
  verdict: { label: "Verdict", bg: "rgba(52,199,123,0.14)", fg: "var(--green)" },
  note: { label: "Note", bg: "var(--bg-hover)", fg: "var(--text-muted)" },
};

export function Messages() {
  const [agent, setAgent] = useState("opencode");
  const [thread, setThread] = useState("project");
  const [threads, setThreads] = useState<string[]>(["project"]);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("update");
  const [to, setTo] = useState("");

  const loadThread = (t: string) => {
    setThread(t);
    api<MessageItem[]>(`/api/messages?thread=${t}`).then((r) => {
      if (r.ok && r.data) setMessages(r.data);
    });
  };

  const loadInbox = () => {
    api<MessageItem[]>(`/api/messages/inbox/${agent}`).then((r) => {
      if (r.ok && r.data) {
        setMessages(r.data);
        const ts = new Set(r.data.map((m) => m.thread));
        setThreads(["project", ...Array.from(ts).filter((t) => t !== "project")]);
      }
    });
  };

  const loadAllThreads = () => {
    api<MessageItem[]>(`/api/messages?thread=project`).then((r) => {
      if (r.ok && r.data) {
        const all = r.data;
        const ts = new Set(all.map((m) => m.thread));
        setThreads(["project", ...Array.from(ts).filter((t) => t !== "project")]);
      }
    });
  };

  useEffect(() => {
    loadThread("project");
    loadAllThreads();
  }, []);

  const post = async () => {
    if (!body) return;
    await api("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thread,
        from: agent,
        to: to || undefined,
        kind,
        body,
      }),
    });
    setBody("");
    loadThread(thread);
  };

  return (
    <div>
      <h1>Messages</h1>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div className="msg-thread-list">
          <div className="section-label" style={{ padding: "0 4px" }}>Threads</div>
          {threads.map((t) => (
            <div
              key={t}
              className={`msg-thread-item${thread === t ? " active" : ""}`}
              onClick={() => loadThread(t)}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div
                  style={{
                    fontSize: "12.5px",
                    fontWeight: 600,
                    color: "#dbe2ea",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t === "project" ? "Project channel" : t}
                </div>
                <span
                  style={{
                    fontSize: "10.5px",
                    fontWeight: 600,
                    color: "#6b7684",
                    background: "var(--bg-hover)",
                    padding: "2px 6px",
                    borderRadius: 20,
                    flexShrink: 0,
                  }}
                >
                  {messages.filter((m) => m.thread === t).length}
                </span>
              </div>
            </div>
          ))}
          <div style={{ marginTop: 16 }}>
            <button className="btn-outline" onClick={loadInbox} style={{ width: "100%" }}>
              Load Inbox for {agent}
            </button>
          </div>
        </div>

        <div className="msg-feed">
          <div className="msg-header">
            <span style={{ fontSize: "13.5px", fontWeight: 700 }}>
              {thread === "project" ? "Project channel" : thread}
            </span>
            <span className="live-dot" style={{ marginLeft: "auto" }}>
              Live
            </span>
          </div>

          <div className="msg-body-scroll">
            {messages.map((m) => {
              const km = KIND_META[m.kind] ?? { label: m.kind, bg: "var(--bg-hover)", fg: "var(--text-muted)" };
              return (
                <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: "12.5px", fontWeight: 700 }}>{m.from_agent}</span>
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                      {m.to_agent ? `→ ${m.to_agent}` : "→ broadcast"}
                    </span>
                    <span className="badge" style={{ background: km.bg, color: km.fg }}>
                      {km.label}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{m.created_at}</span>
                  </div>
                  <div className="msg-bubble">{m.body}</div>
                </div>
              );
            })}
            {messages.length === 0 && (
              <div style={{ color: "var(--text-dim)", textAlign: "center", padding: 40 }}>
                No messages.
              </div>
            )}
          </div>

          <div className="msg-compose">
            <input
              className="input"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              placeholder="agent"
              style={{ width: 100 }}
            />
            <input
              className="input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="to"
              style={{ width: 100 }}
            />
            <select
              className="input"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              style={{ width: 110 }}
            >
              <option>update</option>
              <option>question</option>
              <option>verdict</option>
              <option>note</option>
            </select>
            <input
              className="input"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Post a message..."
              style={{ flex: 1 }}
            />
            <button className="btn-primary" onClick={post}>
              Post
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
