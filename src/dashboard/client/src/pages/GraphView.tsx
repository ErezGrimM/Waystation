import { useEffect, useState } from "react";

export function GraphView() {
  const [exists, setExists] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/graphify-out/graph.html")
      .then((r) => setExists(r.ok))
      .catch(() => setExists(false));
  }, []);

  if (exists === null) return <div>Checking for graph data...</div>;

  if (!exists) {
    return (
      <div style={{ color: "var(--text-dim)", padding: 40, textAlign: "center" }}>
        No graph found. Run <code style={{ fontFamily: "var(--mono)", background: "var(--bg-hover)", padding: "2px 6px", borderRadius: 4 }}>graphify extract .</code> to build one.
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
