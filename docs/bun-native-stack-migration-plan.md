# Bun-Native Stack Migration Plan

## Goal

Reduce Waystation's runtime dependency surface where Bun 1.4 provides an adequate primitive, without changing the ledger's observable behavior, CLI contract, dashboard API contract, or compiled-binary distribution model.

## Baseline and guardrails

Waystation already uses Bun for tests, subprocesses, HTTP serving, file serving, SQLite, building, and binary compilation. The remaining candidate packages provide higher-level abstractions:

- `commander` for command parsing, help, validation, and exit behavior.
- `hono` for dashboard routing and middleware.
- `vite` and `@vitejs/plugin-react` for dashboard client development and production assets.

The migration must preserve the single write path (`src/core/store.ts`), `CommandResult` envelopes, dashboard API response shapes, CLI JSON output, status codes, and compiled-dashboard asset serving. It must not remove `zod`, `proper-lockfile`, the MCP SDK, OpenAI SDK, or React merely because Bun is the runtime.

## Work sequence

```text
task-bun-native-cli-parser              (independent)
task-bun-native-dashboard-build ───────► task-bun-native-dashboard-router
```

The dashboard build task comes before the router task because it establishes Bun-owned production and watch artifacts while preserving the current server/API behavior. The router migration then has a stable client distribution contract to test against.

## Task 1: Native CLI parser

Replace Commander with a local parsing/dispatch layer built on `Bun.argv`. First capture the public command grammar, all help text, global options, command options, JSON mode, diagnostic output, and exit codes in tests. Implement a typed command specification so help and validation are generated from a single source. Remove `commander` only after source-mode and compiled-binary parity tests pass.

## Task 2: Bun dashboard build

Replace Vite's production asset build with `Bun.build`, using React's JSX transform and a generated static-output manifest. Keep development watch/HMR behavior explicitly scoped: either provide an equivalent Bun watch workflow or retain Vite only as a development dependency until a replacement is proven. Preserve the `dashboard:build` and `build` script interfaces so compiled-binary asset embedding continues to work. Remove Vite and its React plugin only if both production and development acceptance criteria are met.

## Task 3: Native dashboard router

Replace Hono routing with a typed route dispatcher passed directly to `Bun.serve`. Preserve every API path, request parser, status code, CORS/header behavior, static-file fallback, SSE behavior, and `CommandResult` JSON response. Test the route contract against the existing dashboard test suite before removing Hono.

## Release gates

For every task: run Bun 1.4 frozen-lockfile install, full tests, typecheck, Biome, production dashboard build, compiled binary smoke tests, `waystation validate --project --views`, and a package/lockfile diff review. Each task gets an implementation commit followed by a separate ledger-closure commit.

## Rollback

Each migration is independently revertible. Keep the existing package and adapter until its replacement passes its contract suite. Do not combine package removal with unrelated dashboard or CLI behavior changes.
