import { useEffect, useState } from "react";

export function GraphView() {
  const [exists, setExists] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/graphify-out/graph.html", { method: "HEAD" })
      .then((r) => setExists(r.ok))
      .catch(() => setExists(false));
  }, []);

  if (exists === null) return <div>Checking...</div>;

  if (!exists) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <h1>Graph</h1>
        <p style={{ color: "var(--text-dim)" }}>
          No graph found. Run <code>graphify extract .</code> to build one.
        </p>
      </div>
    );
  }

  return (
    <div style={{ height: "calc(100vh - 90px)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
      <p style={{ color: "var(--text-dim)", fontSize: 14 }}>
        Interactive knowledge graph — 1,060 nodes, 1,644 edges, 60 communities
      </p>
      <a
        href="/graphify-out/graph.html"
        target="_blank"
        rel="noopener noreferrer"
        className="btn-primary"
        style={{ textDecoration: "none", fontSize: 14, padding: "12px 24px" }}
      >
        Open Graph Visualization
      </a>
      <p style={{ color: "var(--text-dim)", fontSize: 11 }}>
        Opens in a new tab. No server needed — self-contained HTML.
      </p>
    </div>
  );
}
