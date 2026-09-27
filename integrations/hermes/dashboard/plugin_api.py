"""Read-only Waystation data endpoints for the native Hermes Monitor.

W08a provides the registry foundation only. Full Monitor views (tasks, issues,
handoffs, discussions) consume the Waystation snapshot/detail CLI/MCP surfaces
through the registered project's pinned MCP route.
"""

from typing import Any

from integrations.hermes.registry.registry import ProjectRegistry


def make_api(registry: ProjectRegistry) -> Any:
    """Build a namespaced REST API for the dashboard backend."""

    class WaystationApi:
        def list_projects(self, _request: Any) -> dict[str, Any]:
            result = registry.list()
            if not result.ok:
                return {"ok": False, "errors": result.errors}
            return {"ok": True, "projects": [r.__dict__ for r in result.data]}

        def get_project(self, request: Any) -> dict[str, Any]:
            key = request.path_params.get("key")
            result = registry.get(key)
            if not result.ok:
                return {"ok": False, "errors": result.errors}
            return {"ok": True, "project": result.data.__dict__}

    return WaystationApi()
