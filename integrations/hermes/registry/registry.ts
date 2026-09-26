import { type PluginState, type RegistryRoute, registryStateKey } from "./storage.ts";
import type {
  BindingReference,
  CreateRegistrationInput,
  ProjectRegistration,
  RegistryDiagnostic,
  RegistryResult,
  RegistryState,
  UpdateRegistrationInput,
} from "./types.ts";

class AsyncMutex {
  private promise: Promise<void> | null = null;

  async acquire(): Promise<() => void> {
    const prev = this.promise;
    let release: () => void = () => {};
    this.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (prev !== null) {
      await prev;
    }
    return release;
  }
}

function ok<T>(data: T, warnings: RegistryDiagnostic[] = []): RegistryResult<T> {
  return { ok: true, data, errors: [], warnings };
}

function fail<T>(code: string, message: string, hint?: string): RegistryResult<T> {
  return { ok: false, data: null, errors: [{ code, message, hint }], warnings: [] };
}

export interface RegistryClock {
  now(): string;
  randomUUID(): string;
}

export interface RegistryFilesystem {
  canonicalize(path: string): Promise<string>;
  rootExists(path: string): Promise<boolean>;
}

export interface ProjectRegistryOptions {
  state: PluginState;
  route: RegistryRoute;
  fs: RegistryFilesystem;
  clock?: RegistryClock;
}

const ACTIVE_STATES: ReadonlySet<ProjectRegistration["state"]> = new Set(["active"]);

/**
 * Versioned project registry stored in Hermes plugin profile-scoped state.
 *
 * - Keys are generated and stable, never derived from project_id, folder name,
 *   or remote URL.
 * - Duplicate filesystem aliases are detected using canonical path comparison.
 * - Writes are atomic under an in-memory lock; production callers supply a
 *   short plugin-config lock around the same read-modify-write cycle.
 * - Retirement hides a project and blocks new bindings while preserving pinned
 *   routing for existing references.
 * - Hard delete and root/server reassignment are refused while referenced.
 * - A missing or corrupt root is reported explicitly and never retargeted.
 */
export class ProjectRegistry {
  private readonly state: PluginState;
  private readonly route: RegistryRoute;
  private readonly fs: RegistryFilesystem;
  private readonly clock: RegistryClock;
  private readonly lock = new AsyncMutex();

  constructor(options: ProjectRegistryOptions) {
    this.state = options.state;
    this.route = options.route;
    this.fs = options.fs;
    this.clock = options.clock ?? {
      now: () => new Date().toISOString(),
      randomUUID: () => crypto.randomUUID(),
    };
  }

  private stateKey(): string {
    return registryStateKey(this.route);
  }

  private async load(): Promise<RegistryState> {
    const raw = await this.state.get(this.stateKey());
    if (raw === undefined || raw === null) {
      return { registrations: {}, references: {} };
    }
    const parsed = raw as RegistryState;
    return {
      registrations: parsed.registrations ?? {},
      references: parsed.references ?? {},
    };
  }

  private async save(value: RegistryState): Promise<void> {
    await this.state.set(this.stateKey(), value);
  }

  private async withLock<T>(fn: () => Promise<RegistryResult<T>>): Promise<RegistryResult<T>> {
    const release = await this.lock.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private referencesFor(state: RegistryState, key: string): BindingReference[] {
    return Object.values(state.references).filter((ref) => ref.registration_key === key);
  }

  async create(input: CreateRegistrationInput): Promise<RegistryResult<ProjectRegistration>> {
    return this.withLock(async () => {
      const state = await this.load();
      const canonical = await this.fs.canonicalize(input.ledger_root);

      for (const existing of Object.values(state.registrations)) {
        if (existing.state === "retired") continue;
        const existingCanonical = await this.fs.canonicalize(existing.ledger_root);
        if (existingCanonical === canonical) {
          return fail<ProjectRegistration>(
            "registry_duplicate_alias",
            `Ledger root is already registered under key ${existing.key}`,
            "Retire or delete the existing registration first.",
          );
        }
      }

      const key = this.clock.randomUUID();
      const registration: ProjectRegistration = {
        key,
        label: input.label,
        ledger_root: input.ledger_root,
        mcp_server: input.mcp_server,
        revision: 1,
        state: "active",
      };

      state.registrations[key] = registration;
      await this.save(state);
      return ok(registration);
    });
  }

  async get(key: string): Promise<RegistryResult<ProjectRegistration>> {
    const state = await this.load();
    const registration = state.registrations[key];
    if (registration === undefined) {
      return fail<ProjectRegistration>("registry_missing_registration", `No registration ${key}`);
    }
    return ok(registration);
  }

  /**
   * List registrations. By default returns active projects; pass
   * `{ includeRetired: true }` to include retired entries.
   */
  async list(options?: {
    includeRetired?: boolean;
  }): Promise<RegistryResult<ProjectRegistration[]>> {
    const state = await this.load();
    const registrations = Object.values(state.registrations);
    if (options?.includeRetired === true) {
      return ok(registrations);
    }
    return ok(registrations.filter((r) => r.state === "active"));
  }

  async retire(key: string): Promise<RegistryResult<ProjectRegistration>> {
    return this.withLock(async () => {
      const state = await this.load();
      const registration = state.registrations[key];
      if (registration === undefined) {
        return fail<ProjectRegistration>("registry_missing_registration", `No registration ${key}`);
      }
      if (registration.state === "retired") {
        return ok(registration);
      }
      const updated: ProjectRegistration = {
        ...registration,
        state: "retired",
        revision: registration.revision + 1,
      };
      state.registrations[key] = updated;
      await this.save(state);
      return ok(updated);
    });
  }

  async delete(key: string): Promise<RegistryResult<void>> {
    return this.withLock(async () => {
      const state = await this.load();
      const registration = state.registrations[key];
      if (registration === undefined) {
        return fail<void>("registry_missing_registration", `No registration ${key}`);
      }
      const refs = this.referencesFor(state, key);
      if (refs.length > 0) {
        return fail<void>(
          "registry_active_reference",
          `Registration ${key} is still referenced by ${refs.length} binding(s)`,
          "Remove all bindings before deleting.",
        );
      }
      if (registration.state === "active") {
        return fail<void>(
          "registry_active_project",
          `Registration ${key} is active; retire it before deleting.`,
        );
      }
      delete state.registrations[key];
      await this.save(state);
      return ok(undefined);
    });
  }

  async update(
    key: string,
    input: UpdateRegistrationInput,
  ): Promise<RegistryResult<ProjectRegistration>> {
    return this.withLock(async () => {
      const state = await this.load();
      const registration = state.registrations[key];
      if (registration === undefined) {
        return fail<ProjectRegistration>("registry_missing_registration", `No registration ${key}`);
      }

      const refs = this.referencesFor(state, key);
      if (refs.length > 0) {
        if (input.ledger_root !== undefined && input.ledger_root !== registration.ledger_root) {
          return fail<ProjectRegistration>(
            "registry_active_reference",
            "Cannot reassign ledger root while bindings reference this registration.",
          );
        }
        if (input.mcp_server !== undefined && input.mcp_server !== registration.mcp_server) {
          return fail<ProjectRegistration>(
            "registry_active_reference",
            "Cannot reassign MCP server while bindings reference this registration.",
          );
        }
      }

      if (input.ledger_root !== undefined) {
        const canonical = await this.fs.canonicalize(input.ledger_root);
        for (const existing of Object.values(state.registrations)) {
          if (existing.key === key || existing.state === "retired") continue;
          const existingCanonical = await this.fs.canonicalize(existing.ledger_root);
          if (existingCanonical === canonical) {
            return fail<ProjectRegistration>(
              "registry_duplicate_alias",
              `Ledger root is already registered under key ${existing.key}`,
            );
          }
        }
      }

      const updated: ProjectRegistration = {
        ...registration,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.ledger_root !== undefined ? { ledger_root: input.ledger_root } : {}),
        ...(input.mcp_server !== undefined ? { mcp_server: input.mcp_server } : {}),
        revision: registration.revision + 1,
      };
      state.registrations[key] = updated;
      await this.save(state);
      return ok(updated);
    });
  }

  async addReference(
    registrationKey: string,
    bindingId: string,
  ): Promise<RegistryResult<BindingReference>> {
    return this.withLock(async () => {
      const state = await this.load();
      const registration = state.registrations[registrationKey];
      if (registration === undefined) {
        return fail<BindingReference>(
          "registry_missing_registration",
          `No registration ${registrationKey}`,
        );
      }
      if (registration.state !== "active") {
        return fail<BindingReference>(
          "registry_retired_project",
          `Registration ${registrationKey} is retired; new bindings are prohibited.`,
        );
      }
      const refKey = `${registrationKey}:${bindingId}`;
      const existingRef = state.references[refKey];
      if (existingRef !== undefined) {
        return ok(existingRef);
      }
      const reference: BindingReference = {
        binding_id: bindingId,
        registration_key: registrationKey,
        created_at: this.clock.now(),
      };
      state.references[refKey] = reference;
      await this.save(state);
      return ok(reference);
    });
  }

  async removeReference(
    registrationKey: string,
    bindingId: string,
  ): Promise<RegistryResult<BindingReference | null>> {
    return this.withLock(async () => {
      const state = await this.load();
      const refKey = `${registrationKey}:${bindingId}`;
      const reference = state.references[refKey];
      if (reference === undefined) {
        return ok(null);
      }
      delete state.references[refKey];
      await this.save(state);
      return ok(reference);
    });
  }

  async listReferences(registrationKey: string): Promise<RegistryResult<BindingReference[]>> {
    const state = await this.load();
    return ok(this.referencesFor(state, registrationKey));
  }

  /**
   * Verify that a registration's ledger root exists and is accessible.
   * A missing or corrupt root returns an explicit error and is never
   * retargeted to another location.
   */
  async validateRoot(key: string): Promise<RegistryResult<void>> {
    const state = await this.load();
    const registration = state.registrations[key];
    if (registration === undefined) {
      return fail<void>("registry_missing_registration", `No registration ${key}`);
    }
    const exists = await this.fs.rootExists(registration.ledger_root);
    if (!exists) {
      return fail<void>(
        "registry_missing_root",
        `Ledger root does not exist or is inaccessible: ${registration.ledger_root}`,
        "Repair the path or create a new registration; the registry will not retarget.",
      );
    }
    return ok(undefined);
  }
}

export { ACTIVE_STATES };
