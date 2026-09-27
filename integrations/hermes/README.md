# Waystation Hermes integration

Single Hermes plugin package that connects the native Hermes runtime to a local
Waystation ledger. Generic ledger behavior stays in `src/core/`; this directory
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

The project registry is stored in Hermes profile-scoped plugin state
(`ctx.state`), never in `.waystation` or browser storage. Each registration has
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
