/**
 * Hermes profile-scoped durable state facade (`ctx.state`, plan §11.2).
 *
 * Implementations are supplied by the host. Tests use an in-memory mock.
 */
export interface PluginState {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/**
 * Identifies the selected runtime and profile route. Worker and Monitor must
 * use the same route to see the same registry; there is no silent
 * "current profile" fallback.
 */
export interface RegistryRoute {
  runtime: string;
  profile: string;
}

export function registryStateKey(route: RegistryRoute): string {
  return `waystation_registry:${route.runtime}:${route.profile}`;
}
