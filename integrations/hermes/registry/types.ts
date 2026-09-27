/**
 * Frozen project-registration shape (freeze §2.4, plan §11.2).
 *
 * The key is a generated stable local identity. It is not derived from the
 * Waystation project_id, folder name, or remote URL.
 */
export interface ProjectRegistration {
  key: string;
  label: string;
  ledger_root: string;
  mcp_server: string;
  revision: number;
  state: "active" | "retired";
}

export interface RegistryDiagnostic {
  code: string;
  message: string;
  hint?: string;
}

export interface RegistryResult<T> {
  ok: boolean;
  data: T | null;
  errors: RegistryDiagnostic[];
  warnings: RegistryDiagnostic[];
}

/**
 * A binding or in-flight call that pins its registration's immutable routing.
 * The registry blocks reassignment and hard deletion while references exist.
 */
export interface BindingReference {
  binding_id: string;
  registration_key: string;
  created_at: string;
}

/**
 * Stored registry state for one Hermes runtime/profile route.
 */
export interface RegistryState {
  registrations: Record<string, ProjectRegistration>;
  references: Record<string, BindingReference>;
}

export interface CreateRegistrationInput {
  label: string;
  ledger_root: string;
  mcp_server: string;
}

export interface UpdateRegistrationInput {
  label?: string;
  ledger_root?: string;
  mcp_server?: string;
}
