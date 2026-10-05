import { ROUTES_AREA, SIDEBAR_NAV_AREA } from "@hermes/plugin-sdk";
import { jsx } from "react/jsx-runtime";

const POC_ROUTE = "/waystation-native-poc";

function Page() {
  return jsx("main", {
    style: {
      display: "grid",
      gap: "0.75rem",
      padding: "2rem",
      maxWidth: "48rem",
      color: "var(--ui-text-primary)"
    },
    children: [
      jsx("h1", {
        children: "Waystation native-load POC",
        style: { margin: 0, fontSize: "1.5rem" }
      }),
      jsx("p", {
        children: "PROOF OF CONCEPT — this page is loaded from an external runtime desktop plugin.",
        style: { margin: 0, color: "var(--ui-text-secondary)" }
      }),
      jsx("p", {
        children: "No Waystation ledger, worker binding, or production monitor is connected.",
        style: { margin: 0, color: "var(--ui-text-secondary)" }
      }),
      jsx("code", {
        children: "plugin id: waystation-native-load-poc | route: /waystation-native-poc",
        style: { color: "var(--ui-accent)" }
      })
    ]
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
      render: Page
    });

    ctx.register({
      id: "nav",
      area: SIDEBAR_NAV_AREA,
      order: 999,
      data: {
        path: POC_ROUTE,
        label: "Waystation POC",
        codicon: "beaker"
      }
    });
  }
};
