import { useEffect, useState } from "react";
import { api } from "../api.ts";

interface Diag {
  code: string;
  message: string;
  hint?: string;
}

export function Validation() {
  const [errors, setErrors] = useState<Diag[]>([]);
  const [warnings, setWarnings] = useState<Diag[]>([]);
  const [loading, setLoading] = useState(true);

  const run = () => {
    setLoading(true);
    api<null>("/api/validate").then((r) => {
      setErrors(r.errors);
      setWarnings(r.warnings);
      setLoading(false);
    });
  };

  useEffect(run, []);

  return (
    <div>
      <h1>Validation</h1>
      <button onClick={run} style={{ padding: "0.35rem 0.75rem", marginBottom: "1rem" }}>
        {loading ? "Running…" : "Run Again"}
      </button>

      {!loading && errors.length === 0 && warnings.length === 0 && <p>All clear. No problems found.</p>}

      {errors.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <h3 style={{ color: "#c00" }}>
            {errors.length} Error{errors.length > 1 ? "s" : ""}
          </h3>
          {errors.map((e, i) => (
            <div key={i} style={{ background: "#fff0f0", border: "1px solid #fcc", borderRadius: 4, padding: "0.5rem", marginBottom: 4 }}>
              <strong>[{e.code}]</strong> {e.message}
              {e.hint && <div style={{ color: "#666", fontSize: "0.85rem" }}>Hint: {e.hint}</div>}
            </div>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div>
          <h3 style={{ color: "#a60" }}>
            {warnings.length} Warning{warnings.length > 1 ? "s" : ""}
          </h3>
          {warnings.map((w, i) => (
            <div key={i} style={{ background: "#fffbe0", border: "1px solid #ed8", borderRadius: 4, padding: "0.5rem", marginBottom: 4 }}>
              <strong>[{w.code}]</strong> {w.message}
              {w.hint && <div style={{ color: "#666", fontSize: "0.85rem" }}>Hint: {w.hint}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
