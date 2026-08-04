/**
 * Tiny in-memory log of every API call the demo makes, so the panel can show
 * the wire traffic. Deliberately framework-free (no React import) so `api.ts`
 * can log without a circular dependency on the UI.
 */

export interface SseEntry {
  at: number;
  raw: string;
}

export interface CallEntry {
  id: number;
  at: number;
  method: string;
  /** Path as requested, e.g. `/api/{org}/collections/{id}/external-search`. */
  url: string;
  /** Headers actually sent, with the embed key redacted. */
  headers: Record<string, string>;
  requestBody?: unknown;
  status?: number;
  /** Non-streaming response body. */
  responseBody?: unknown;
  /** Streaming responses accumulate parsed SSE events here. */
  events: SseEntry[];
  error?: string;
  durationMs?: number;
}

/** Keeps memory bounded during a long demo session. */
const MAX_ENTRIES = 200;

let entries: CallEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  // New array identity so useSyncExternalStore sees a change.
  entries = entries.slice();
  for (const l of listeners) l();
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getEntries() {
  return entries;
}

export function clearEntries() {
  entries = [];
  emit();
}

/**
 * An embed key is public by design, but printing it in full invites copy-paste
 * into bug reports and screenshots. Show enough to identify which key is in
 * play, never the whole secret.
 */
export function redactKey(value: string) {
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  if (!match) return value;
  const key = match[1];
  if (key.length <= 12) return 'Bearer ' + '…';
  return `Bearer ${key.slice(0, 8)}…${key.slice(-4)}`;
}

export function startCall(init: {
  method: string;
  url: string;
  headers: Record<string, string>;
  requestBody?: unknown;
}): CallEntry {
  const entry: CallEntry = {
    id: nextId++,
    at: Date.now(),
    method: init.method,
    url: init.url,
    headers: Object.fromEntries(
      Object.entries(init.headers).map(([k, v]) => [
        k,
        k.toLowerCase() === 'authorization' ? redactKey(v) : v,
      ]),
    ),
    requestBody: init.requestBody,
    events: [],
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  emit();
  return entry;
}

export function finishCall(
  entry: CallEntry,
  patch: Partial<Pick<CallEntry, 'status' | 'responseBody' | 'error'>>,
) {
  Object.assign(entry, patch, { durationMs: Date.now() - entry.at });
  emit();
}

/**
 * Forget a call entirely. Used for aborted requests: the demo cancels in-flight
 * calls on re-search and unmount, and logging those as failures would teach a
 * reader that the API errored when nothing went wrong.
 */
export function dropCall(entry: CallEntry) {
  entries = entries.filter((e) => e !== entry);
  emit();
}

export function logSse(entry: CallEntry, raw: string) {
  entry.events.push({ at: Date.now(), raw });
  emit();
}
