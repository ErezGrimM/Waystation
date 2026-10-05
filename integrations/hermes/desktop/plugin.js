import { ROUTES_AREA, SIDEBAR_NAV_AREA } from "@hermes/plugin-sdk";
import { jsx } from "react/jsx-runtime";
import React from "react";
import {
  readTasks,
  readClaims,
  readMessages,
  SubprocessError,
} from "./waystation-data.ts";

const POC_ROUTE = "/waystation-native-poc";

// ─── POC 1 static content ────────────────────────────────────────────────────

function PocStaticContent() {
  return jsx("section", {
    style: {
      border: "1px solid var(--ui-border, #444)",
      borderRadius: "6px",
      padding: "1rem",
      marginBottom: "1.5rem",
    },
    children: [
      jsx("h2", {
        children: "Waystation native-load POC",
        style: { margin: 0, fontSize: "1.1rem" },
      }),
      jsx("p", {
        children: "PROOF OF CONCEPT — this page is loaded from an external runtime desktop plugin.",
        style: { margin: "0.5rem 0 0", color: "var(--ui-text-secondary)" },
      }),
      jsx("p", {
        children: "No Waystation ledger, worker binding, or production monitor is connected.",
        style: { margin: "0.25rem 0 0", color: "var(--ui-text-secondary)" },
      }),
      jsx("code", {
        children: "plugin id: waystation-native-load-poc | route: /waystation-native-poc",
        style: { color: "var(--ui-accent)" },
      }),
    ],
  });
}

// ─── Project Monitor ─────────────────────────────────────────────────────────

const DEMO_ROOT = "C:/projects/Waystation";

function ProjectMonitor() {
  const [tasks, setTasks] = React.useState([]);
  const [claims, setClaims] = React.useState([]);
  const [selectedTask, setSelectedTask] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [lastRead, setLastRead] = React.useState(null);
  const [stale, setStale] = React.useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    setStale(false);
    try {
      const [taskList, claimList] = await Promise.all([
        readTasks(DEMO_ROOT),
        readClaims(DEMO_ROOT),
      ]);
      setTasks(taskList);
      setClaims(claimList);
      setLastRead(new Date().toISOString());
    } catch (err) {
      const message =
        err instanceof SubprocessError ? err.message : String(err);
      setError(message);
      setStale(tasks.length > 0);
    } finally {
      setLoading(false);
    }
  }

  async function selectTask(task) {
    setSelectedTask(task);
    setMessages([]);
    if (!task) return;
    try {
      const msgs = await readMessages(DEMO_ROOT, task.id);
      setMessages(msgs);
    } catch {
      setMessages([]);
    }
  }

  function getActiveClaim(taskId) {
    return claims.find((c) => c.task === taskId && c.status === "active");
  }

  return jsx("section", {
    style: {
      border: "1px solid var(--ui-border, #444)",
      borderRadius: "6px",
      padding: "1rem",
    },
    children: [
      jsx("div", {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.75rem",
        },
        children: [
          jsx("h2", {
            children: "Waystation Project Monitor",
            style: { margin: 0, fontSize: "1.1rem" },
          }),
          jsx("button", {
            onClick: refresh,
            disabled: loading,
            style: {
              padding: "0.35rem 0.75rem",
              borderRadius: "4px",
              border: "1px solid var(--ui-border, #444)",
              background: loading
                ? "var(--ui-bg-disabled, #333)"
                : "var(--ui-accent, #0066cc)",
              color: loading
                ? "var(--ui-text-secondary, #888)"
                : "var(--ui-text-on-accent, #fff)",
              cursor: loading ? "default" : "pointer",
              fontSize: "0.85rem",
            },
            children: loading ? "Loading..." : "Refresh",
          }),
        ],
      }),
      jsx("p", {
        children: `Project: ${DEMO_ROOT}`,
        style: {
          margin: "0 0 0.5rem",
          color: "var(--ui-text-secondary)",
          fontSize: "0.85rem",
          fontFamily: "monospace",
        },
      }),
      lastRead &&
        jsx("p", {
          children: `Last successful read: ${lastRead}${stale ? " (stale)" : ""}`,
          style: {
            margin: "0 0 0.75rem",
            color: stale ? "var(--ui-warning, #cc8800)" : "var(--ui-text-secondary)",
            fontSize: "0.8rem",
          },
        }),
      error &&
        jsx("div", {
          style: {
            padding: "0.5rem 0.75rem",
            marginBottom: "0.75rem",
            borderRadius: "4px",
            background: "var(--ui-bg-error, #3a1111)",
            color: "var(--ui-text-error, #ff6666)",
            fontSize: "0.85rem",
          },
          children: [
            jsx("strong", { children: "Error: " }),
            error,
          ],
        }),
      loading &&
        jsx("p", {
          children: "Loading tasks...",
          style: { color: "var(--ui-text-secondary)", fontStyle: "italic" },
        }),
      !loading && !error && tasks.length === 0 &&
        jsx("p", {
          children: "No tasks found in this project.",
          style: { color: "var(--ui-text-secondary)", fontStyle: "italic" },
        }),
      !loading && tasks.length > 0 &&
        jsx("div", {
          style: { display: "grid", gap: "0.5rem" },
          children: tasks.map((task) => {
            const claim = getActiveClaim(task.id);
            const isSelected = selectedTask?.id === task.id;
            return jsx("div", {
              key: task.id,
              onClick: () => selectTask(task),
              style: {
                padding: "0.5rem 0.75rem",
                borderRadius: "4px",
                border: isSelected
                  ? "1px solid var(--ui-accent, #0066cc)"
                  : "1px solid var(--ui-border, #333)",
                background: isSelected
                  ? "var(--ui-bg-selected, #1a2a3a)"
                  : "var(--ui-bg-secondary, #1a1a1a)",
                cursor: "pointer",
              },
              children: [
                jsx("div", {
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  },
                  children: [
                    jsx("span", {
                      children: task.title,
                      style: { fontWeight: 500 },
                    }),
                    jsx("span", {
                      children: task.status,
                      style: {
                        fontSize: "0.75rem",
                        padding: "0.1rem 0.4rem",
                        borderRadius: "3px",
                        background: "var(--ui-bg-tertiary, #2a2a2a)",
                        color: "var(--ui-text-secondary)",
                      },
                    }),
                  ],
                }),
                jsx("div", {
                  style: {
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: "0.25rem",
                    fontSize: "0.8rem",
                    color: "var(--ui-text-secondary)",
                  },
                  children: [
                    jsx("span", { children: task.id }),
                    claim
                      ? jsx("span", {
                          children: `Claimed by ${claim.agent}`,
                          style: { color: "var(--ui-accent, #0066cc)" },
                        })
                      : jsx("span", { children: "Unclaimed" }),
                  ],
                }),
              ],
            });
          }),
        }),
      selectedTask &&
        jsx("div", {
          style: { marginTop: "1rem" },
          children: [
            jsx("h3", {
              children: `Task: ${selectedTask.title}`,
              style: { margin: "0 0 0.5rem", fontSize: "1rem" },
            }),
            jsx("div", {
              style: {
                padding: "0.75rem",
                borderRadius: "4px",
                background: "var(--ui-bg-secondary, #1a1a1a)",
                marginBottom: "0.75rem",
              },
              children: [
                jsx("div", {
                  style: { marginBottom: "0.5rem" },
                  children: [
                    jsx("strong", { children: "ID: " }),
                    jsx("span", { children: selectedTask.id }),
                  ],
                }),
                jsx("div", {
                  style: { marginBottom: "0.5rem" },
                  children: [
                    jsx("strong", { children: "Status: " }),
                    jsx("span", { children: selectedTask.status }),
                  ],
                }),
                selectedTask.description &&
                  jsx("div", {
                    style: { marginBottom: "0.5rem" },
                    children: [
                      jsx("strong", { children: "Description: " }),
                      jsx("p", {
                        children: selectedTask.description,
                        style: {
                          margin: "0.25rem 0 0",
                          color: "var(--ui-text-secondary)",
                          whiteSpace: "pre-wrap",
                        },
                      }),
                    ],
                  }),
                selectedTask.acceptance &&
                  selectedTask.acceptance.length > 0 &&
                  jsx("div", {
                    children: [
                      jsx("strong", { children: "Acceptance criteria:" }),
                      jsx("ul", {
                        style: { margin: "0.25rem 0 0", paddingLeft: "1.25rem" },
                        children: selectedTask.acceptance.map((item, i) =>
                          jsx("li", { key: i, children: item }),
                        ),
                      }),
                    ],
                  }),
              ],
            }),
            jsx("h4", {
              children: "Discussion",
              style: { margin: "0 0 0.5rem", fontSize: "0.9rem" },
            }),
            messages.length === 0 &&
              jsx("p", {
                children: "No messages on this thread.",
                style: {
                  color: "var(--ui-text-secondary)",
                  fontStyle: "italic",
                  fontSize: "0.85rem",
                },
              }),
            messages.length > 0 &&
              jsx("div", {
                style: { display: "grid", gap: "0.5rem" },
                children: messages.map((msg) =>
                  jsx("div", {
                    key: msg.id,
                    style: {
                      padding: "0.5rem 0.75rem",
                      borderRadius: "4px",
                      border: "1px solid var(--ui-border, #333)",
                      background: "var(--ui-bg-secondary, #1a1a1a)",
                    },
                    children: [
                      jsx("div", {
                        style: {
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: "0.75rem",
                          color: "var(--ui-text-secondary)",
                          marginBottom: "0.25rem",
                        },
                        children: [
                          jsx("span", {
                            children: msg.to_agent
                              ? `${msg.from_agent} → ${msg.to_agent}`
                              : `${msg.from_agent} → (all)`,
                          }),
                          jsx("span", { children: msg.created_at }),
                        ],
                      }),
                      jsx("div", {
                        children: msg.body,
                        style: { fontSize: "0.85rem", whiteSpace: "pre-wrap" },
                      }),
                    ],
                  }),
                ),
              }),
          ],
        }),
    ],
  });
}

// ─── Page ────────────────────────────────────────────────────────────────────

function Page() {
  return jsx("main", {
    style: {
      display: "grid",
      gap: "0.75rem",
      padding: "2rem",
      maxWidth: "48rem",
      color: "var(--ui-text-primary)",
    },
    children: [
      jsx("h1", {
        children: "Waystation native-load POC",
        style: { margin: 0, fontSize: "1.5rem" },
      }),
      jsx(PocStaticContent),
      jsx(ProjectMonitor),
    ],
  });
}

export default {
  id: "waystation-native-load-poc",
  name: "Waystation native-load POC",
  description: "Bounded native Hermes plugin page proof; no ledger connection.",
  defaultEnabled: false,
  register(ctx) {
    ctx.register({
      id: "page",
      area: ROUTES_AREA,
      title: "Waystation native-load POC",
      data: { path: POC_ROUTE },
      render: Page,
    });

    ctx.register({
      id: "nav",
      area: SIDEBAR_NAV_AREA,
      order: 999,
      data: {
        path: POC_ROUTE,
        label: "Waystation POC",
        codicon: "beaker",
      },
    });
  },
};
