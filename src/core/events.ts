type Listener = (event: Record<string, unknown>) => void;

const listeners = new Set<Listener>();

export function emitMutationEvent(event: Record<string, unknown>): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // drop misbehaving listener
    }
  }
}

export function onMutationEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
