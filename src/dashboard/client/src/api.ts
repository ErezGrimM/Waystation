interface CommandResult<T = unknown> {
  ok: boolean;
  data: T | null;
  errors: Array<{ code: string; message: string; hint?: string }>;
  warnings: Array<{ code: string; message: string; hint?: string }>;
}

export async function api<T>(path: string, init?: RequestInit): Promise<CommandResult<T>> {
  try {
    const res = await fetch(path, init);
    const json = (await res.json()) as CommandResult<T>;
    if (!res.ok && json.errors.length === 0) {
      return errorResult<T>(`request failed with HTTP ${res.status}`);
    }
    return json;
  } catch (e) {
    return errorResult<T>((e as Error).message || "request failed");
  }
}

function errorResult<T>(message: string): CommandResult<T> {
  return {
    ok: false,
    data: null,
    errors: [{ code: "unexpected_error", message }],
    warnings: [],
  };
}
