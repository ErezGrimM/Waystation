interface CommandResult<T = unknown> {
  ok: boolean;
  data: T | null;
  errors: Array<{ code: string; message: string; hint?: string }>;
  warnings: Array<{ code: string; message: string; hint?: string }>;
}

export async function api<T>(path: string, init?: RequestInit): Promise<CommandResult<T>> {
  const res = await fetch(path, init);
  const json = (await res.json()) as CommandResult<T>;
  return json;
}
