"""Waystation Hermes plugin assembly and registration entrypoint.

W08a owns the registry foundation. The worker adapter (W07) supplies binding
management on top of this registration surface.
"""

from typing import Any

__version__ = "0.1.0"
__all__ = ["register_plugin", "ProjectRegistry"]


def register_plugin(ctx: Any) -> Any:
    """Register the Waystation plugin with a Hermes runtime context.

    The registry lives in profile-scoped plugin state (ctx.state). Data
    endpoints accept only registration keys and record identifiers; they never
    accept arbitrary paths or command names.
    """
    # W08a foundation: wire the registry and dashboard API. Worker binding
    # adapters are contributed by W07.
    from integrations.hermes.dashboard.plugin_api import make_api
    from integrations.hermes.registry.registry import ProjectRegistry

    registry = ProjectRegistry(state=ctx.state, route={"runtime": ctx.runtime, "profile": ctx.profile})
    api = make_api(registry)
    ctx.rest.mount("/registry", api)
    return {"registry": registry, "api": api}


class ProjectRegistry:
    """Python placeholder that delegates to the TypeScript registry in W08a.

    The authoritative implementation is integrations/hermes/registry/registry.ts.
    This class exists only so assembly code can import a stable symbol.
    """

    def __init__(self, state: Any, route: dict[str, str]) -> None:
        self.state = state
        self.route = route
