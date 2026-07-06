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
    <iframe
      src="/graphify-out/graph.html"
      style={{
        width: "100%",
        height: "calc(100vh - 90px)",
        border: "none",
        borderRadius: 8,
      }}
    />
  );
}
