# Waystation Hermes integration

Foundation for a single Hermes plugin package. It does not yet connect the native
runtime to a ledger or expose a Monitor. Generic ledger behavior stays in `src/core/`; this directory
contains only the Hermes-specific adapter, registry, and Monitor surface.

## Structure

```
integrations/hermes/
  plugin.yaml              # Hermes plugin manifest
  __init__.py              # Assembly/registration entrypoint
  registry/                # Authoritative project registry
    registry.ts            # ProjectRegistration store (freeze §2.4)
    types.ts               # Frozen interfaces
    storage.ts             # ctx.state adapter
    node-fs.ts             # Production filesystem adapter
  worker/                  # Session binding and MCP forwarding (W07)
  contracts/               # Generated/shared Waystation tool contracts (W06)
  dashboard/               # Native Monitor backend
    manifest.json
    plugin_api.py
  desktop/                 # Native Monitor desktop artifact
    plugin.js
  tests/                   # Reserved for W08 integration fixtures
```

## Registry

The project registry accepts a profile-scoped `PluginState` adapter. W08b/W08d
must implement and verify the host bridge; `ctx.state` is a planned integration
contract, not a currently wired Python-to-TypeScript interface. State must never
live in `.waystation` or browser storage. Each registration has
a generated stable key independent of folder name, Waystation `project_id`, or
remote URL.

Key behaviors:

- Duplicate filesystem aliases are detected after canonicalization.
- Retirement hides a project from ordinary Monitor selection and blocks new
  bindings while preserving pinned routing for existing bindings across restart.
- Hard delete and root/server reassignment are refused while bindings or
  in-flight calls reference the registration.
- A genuinely missing or corrupt ledger root errors explicitly and is never
  silently retargeted.

## Development

The registry is unit-tested in `test/hermes-registry.test.ts` against a mock
`ctx.state` and filesystem. Run with:

```powershell
& "C:/bun/bin/bun.exe" test test/hermes-registry.test.ts
```

## Scope notes

- W08a owns the registry foundation and package skeleton.
- W07 owns the worker adapter and binding store.
- W08b/W08c own the Monitor backend and native UI.
- W08d owns final assembly.

The scaffold's `register(ctx)` imports successfully but intentionally registers
no tools or routes. The previous cross-language placeholder imports were removed
during reconciliation. Registry operations serialize across facades sharing one
state adapter; the future production adapter must additionally provide durable,
cross-process serialization. Runtime/profile state keys use an encoded tuple to
avoid delimiter collisions. There is no released legacy registry to migrate.

## Native POC Monitor bridge

The native desktop runtime accepts imports from `@hermes/plugin-sdk` and `react`
only. The Monitor page uses the SDK's `ctx.rest` call to the paired Hermes
backend route at `/api/plugins/waystation-native-load-poc`; its Python router is
mounted from `dashboard/manifest.json` by the supported Hermes dashboard plugin
API. The router reads `WAYSTATION_ROOT`, `WAYSTATION_REPO`, and `WAYSTATION_BUN`
from the backend process environment. Those paths are fixed for that backend
process; requests cannot select a ledger root or command. Missing configuration,
failed reads, invalid output, timeouts, and oversized output return explicit
errors.

The Python backend plugin must be installed and enabled in the Hermes profile
that serves the native renderer. This is a read-only single-project POC bridge;
it does not configure profile routing or replace the deferred session-aware
worker adapter.
