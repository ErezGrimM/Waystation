import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type PluginState,
  ProjectRegistry,
  type RegistryFilesystem,
  type RegistryRoute,
  registryStateKey,
} from "../integrations/hermes/registry/index.ts";

class MemoryState implements PluginState {
  private data = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.data.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  snapshot(): Map<string, unknown> {
    return new Map(this.data);
  }
}

function mockFilesystem(
  aliases: Record<string, string>,
  existing: Set<string>,
): RegistryFilesystem {
  return {
    async canonicalize(path: string): Promise<string> {
      return aliases[path] ?? path;
    },
    async rootExists(path: string): Promise<boolean> {
      return existing.has(path);
    },
  };
}

function deterministicClock(): { now: () => string; randomUUID: () => string } {
  let counter = 0;
  return {
    now: () => `2026-09-26T12:00:00.${counter++}+03:00`,
    randomUUID: () => {
      counter += 1;
      return `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
    },
  };
}

function route(runtime = "desktop", profile = "default"): RegistryRoute {
  return { runtime, profile };
}

describe("ProjectRegistry", () => {
  let state: MemoryState;
  let fs: RegistryFilesystem;
  let clock: ReturnType<typeof deterministicClock>;

  beforeEach(() => {
    state = new MemoryState();
    fs = mockFilesystem(
      {
        "C:/Projects/A": "C:/Projects/A",
        "C:/Projects/a": "C:/Projects/A",
        "C:/Projects/B": "C:/Projects/B",
        "C:/Junctions/A": "C:/Projects/A",
      },
      new Set(["C:/Projects/A", "C:/Projects/B"]),
    );
    clock = deterministicClock();
  });

  afterEach(() => {
    // Ensure tests clean up only the fixture roots they made (the in-memory
    // state is scoped to the test instance).
  });

  function registry(rt: RegistryRoute = route()) {
    return new ProjectRegistry({ state, route: rt, fs, clock });
  }

  test("creates a registration with a stable generated key", async () => {
    const reg = registry();
    const result = await reg.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });
    expect(result.ok).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.data!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.data!.label).toBe("A");
    expect(result.data!.ledger_root).toBe("C:/Projects/A");
    expect(result.data!.mcp_server).toBe("mcp-a");
    expect(result.data!.revision).toBe(1);
    expect(result.data!.state).toBe("active");
  });

  test("key is independent of label, ledger_root and mcp_server", async () => {
    const reg = registry();
    const a = await reg.create({ label: "A", ledger_root: "C:/Projects/A", mcp_server: "mcp-a" });
    const b = await reg.create({ label: "A", ledger_root: "C:/Projects/B", mcp_server: "mcp-a" });
    expect(a.data!.key).not.toBe(b.data!.key);
    expect(a.data!.ledger_root).not.toBe(b.data!.ledger_root);
  });

  test("detects duplicate filesystem aliases including Windows case variants", async () => {
    const reg = registry();
    await reg.create({ label: "A", ledger_root: "C:/Projects/A", mcp_server: "mcp-a" });
    const duplicate = await reg.create({
      label: "A-case",
      ledger_root: "C:/Projects/a",
      mcp_server: "mcp-a",
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors[0]?.code).toBe("registry_duplicate_alias");
  });

  test("detects duplicate aliases through Windows junctions", async () => {
    const reg = registry();
    await reg.create({ label: "A", ledger_root: "C:/Projects/A", mcp_server: "mcp-a" });
    const duplicate = await reg.create({
      label: "A-junction",
      ledger_root: "C:/Junctions/A",
      mcp_server: "mcp-a",
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors[0]?.code).toBe("registry_duplicate_alias");
  });

  test("isolates registries by runtime/profile route", async () => {
    const desktop = registry(route("desktop", "default"));
    const server = registry(route("server", "default"));
    const created = await desktop.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });
    expect(created.ok).toBe(true);

    const fromServer = await server.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });
    expect(fromServer.ok).toBe(true);

    const desktopList = await desktop.list();
    expect(desktopList.data).toHaveLength(1);
    const serverList = await server.list();
    expect(serverList.data).toHaveLength(1);

    expect(registryStateKey(route("desktop", "default"))).toBe(
      "waystation_registry:desktop:default",
    );
  });

  test("list returns only active registrations by default", async () => {
    const reg = registry();
    const a = await reg.create({ label: "A", ledger_root: "C:/Projects/A", mcp_server: "mcp-a" });
    await reg.create({ label: "B", ledger_root: "C:/Projects/B", mcp_server: "mcp-b" });
    await reg.retire(a.data!.key);

    const active = await reg.list();
    expect(active.data).toHaveLength(1);
    expect(active.data![0]!.key).not.toBe(a.data!.key);

    const all = await reg.list({ includeRetired: true });
    expect(all.data).toHaveLength(2);
  });

  test("retirement blocks new bindings while preserving existing references", async () => {
    const reg = registry();
    const created = await reg.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });
    const ref = await reg.addReference(created.data!.key, "binding-1");
    expect(ref.ok).toBe(true);

    const retired = await reg.retire(created.data!.key);
    expect(retired.ok).toBe(true);
    expect(retired.data!.state).toBe("retired");

    const refs = await reg.listReferences(created.data!.key);
    expect(refs.data).toHaveLength(1);

    const blocked = await reg.addReference(created.data!.key, "binding-2");
    expect(blocked.ok).toBe(false);
    expect(blocked.errors[0]?.code).toBe("registry_retired_project");
  });

  test("hard delete is refused while referenced", async () => {
    const reg = registry();
    const created = await reg.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });
    await reg.addReference(created.data!.key, "binding-1");

    const del = await reg.delete(created.data!.key);
    expect(del.ok).toBe(false);
    expect(del.errors[0]?.code).toBe("registry_active_reference");
  });

  test("hard delete is refused while active", async () => {
    const reg = registry();
    const created = await reg.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });

    const del = await reg.delete(created.data!.key);
    expect(del.ok).toBe(false);
    expect(del.errors[0]?.code).toBe("registry_active_project");
  });

  test("hard delete succeeds after retirement and reference removal", async () => {
    const reg = registry();
    const created = await reg.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });
    await reg.addReference(created.data!.key, "binding-1");
    await reg.retire(created.data!.key);
    await reg.removeReference(created.data!.key, "binding-1");

    const del = await reg.delete(created.data!.key);
    expect(del.ok).toBe(true);

    const missing = await reg.get(created.data!.key);
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]?.code).toBe("registry_missing_registration");
  });

  test("root reassignment is refused while referenced", async () => {
    const reg = registry();
    const created = await reg.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });
    await reg.addReference(created.data!.key, "binding-1");

    const update = await reg.update(created.data!.key, { ledger_root: "C:/Projects/B" });
    expect(update.ok).toBe(false);
    expect(update.errors[0]?.code).toBe("registry_active_reference");
  });

  test("server reassignment is refused while referenced", async () => {
    const reg = registry();
    const created = await reg.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });
    await reg.addReference(created.data!.key, "binding-1");

    const update = await reg.update(created.data!.key, { mcp_server: "mcp-b" });
    expect(update.ok).toBe(false);
    expect(update.errors[0]?.code).toBe("registry_active_reference");
  });

  test("label reassignment is allowed while referenced", async () => {
    const reg = registry();
    const created = await reg.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });
    await reg.addReference(created.data!.key, "binding-1");

    const update = await reg.update(created.data!.key, { label: "Renamed" });
    expect(update.ok).toBe(true);
    expect(update.data!.label).toBe("Renamed");
    expect(update.data!.revision).toBe(2);
  });

  test("missing root validation errors explicitly without retargeting", async () => {
    const reg = registry();
    const created = await reg.create({
      label: "A",
      ledger_root: "C:/Missing",
      mcp_server: "mcp-a",
    });

    const validated = await reg.validateRoot(created.data!.key);
    expect(validated.ok).toBe(false);
    expect(validated.errors[0]?.code).toBe("registry_missing_root");
    expect(validated.errors[0]?.hint).toContain("will not retarget");
  });

  test("existing root validation succeeds", async () => {
    const reg = registry();
    const created = await reg.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });

    const validated = await reg.validateRoot(created.data!.key);
    expect(validated.ok).toBe(true);
  });

  test("concurrent creates are atomic and do not leak duplicates", async () => {
    const reg = registry();
    const attempts = await Promise.all([
      reg.create({ label: "A", ledger_root: "C:/Projects/A", mcp_server: "mcp-a" }),
      reg.create({ label: "B", ledger_root: "C:/Projects/A", mcp_server: "mcp-b" }),
      reg.create({ label: "C", ledger_root: "C:/Projects/A", mcp_server: "mcp-c" }),
    ]);

    const successes = attempts.filter((r) => r.ok);
    expect(successes).toHaveLength(1);

    const list = await reg.list();
    expect(list.data).toHaveLength(1);
  });

  test("duplicate root detection uses canonical comparison, not raw strings", async () => {
    const reg = registry();
    await reg.create({ label: "A", ledger_root: "C:/Projects/A", mcp_server: "mcp-a" });
    const second = await reg.create({
      label: "B",
      ledger_root: "C:/Projects/a",
      mcp_server: "mcp-b",
    });
    expect(second.ok).toBe(false);
  });

  test("updating to a duplicate alias is rejected", async () => {
    const reg = registry();
    const a = await reg.create({ label: "A", ledger_root: "C:/Projects/A", mcp_server: "mcp-a" });
    const b = await reg.create({ label: "B", ledger_root: "C:/Projects/B", mcp_server: "mcp-b" });

    const update = await reg.update(a.data!.key, { ledger_root: "C:/Projects/B" });
    expect(update.ok).toBe(false);
    expect(update.errors[0]?.code).toBe("registry_duplicate_alias");

    const unchanged = await reg.get(b.data!.key);
    expect(unchanged.data!.ledger_root).toBe("C:/Projects/B");
  });

  test("reference ids are scoped to a registration", async () => {
    const reg = registry();
    const a = await reg.create({ label: "A", ledger_root: "C:/Projects/A", mcp_server: "mcp-a" });
    const b = await reg.create({ label: "B", ledger_root: "C:/Projects/B", mcp_server: "mcp-b" });

    await reg.addReference(a.data!.key, "shared-binding");
    await reg.addReference(b.data!.key, "shared-binding");

    const refsA = await reg.listReferences(a.data!.key);
    const refsB = await reg.listReferences(b.data!.key);
    expect(refsA.data).toHaveLength(1);
    expect(refsB.data).toHaveLength(1);
  });

  test("get returns retired registrations", async () => {
    const reg = registry();
    const created = await reg.create({
      label: "A",
      ledger_root: "C:/Projects/A",
      mcp_server: "mcp-a",
    });
    await reg.retire(created.data!.key);

    const got = await reg.get(created.data!.key);
    expect(got.ok).toBe(true);
    expect(got.data!.state).toBe("retired");
  });
});
