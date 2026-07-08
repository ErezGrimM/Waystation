/** Small shared UI primitives for the dashboard. */
import type { ReactNode } from "react";

/**
 * A dismissible-looking error banner. Renders nothing when `message` is empty,
 * so pages can always mount it. Surfaces fetch failures that would otherwise
 * leave a silently-empty or stale view (audit M6).
 */
export function ErrorBanner({
  message,
  onRetry,
}: {
  message?: string | null;
  onRetry?: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "rgba(239,83,80,0.10)",
        border: "1px solid rgba(239,83,80,0.35)",
        color: "var(--red)",
        borderRadius: 8,
        padding: "10px 14px",
        marginBottom: 12,
        fontSize: 13,
      }}
    >
      <span style={{ flex: 1 }}>⚠ {message}</span>
      {onRetry && (
        <button className="btn-outline" onClick={onRetry} style={{ flexShrink: 0 }}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Muted centered placeholder for loading / empty states. */
export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div style={{ color: "var(--text-dim)", padding: 40, textAlign: "center" }}>{children}</div>
  );
}
