/**
 * Reference client for the Capitol AI external-chat REST API.
 *
 * Everything a headless integration needs lives in this file. Four endpoints,
 * all authenticated with an embed API key (`Authorization: Bearer eak_...`):
 *
 *   POST {base}/{orgid}/collections/{cid}/external-search        SSE
 *   POST {base}/{orgid}/collections/{cid}/external-chat          SSE
 *   GET  {base}/{orgid}/collections/{cid}/external-chat/facet    JSON
 *   GET  {base}/{orgid}/collections/{cid}/external-chat/filters  JSON
 *
 * `{base}` is the API's *public* app (`.../public`). The admin endpoints
 * (config, keys, instruction versions) are NOT reachable with an embed key —
 * they require a user JWT or M2M token.
 *
 * Auth failure modes worth handling in a real integration:
 *   401  missing / invalid / revoked key
 *   403  key not scoped to this org or collection, or Origin not in the key's
 *        allowed_domains, or facet requested on an undeclared field
 *   429  per-key or per-IP rate limit; honour the `Retry-After` header
 */

import { config } from './config';
import { dropCall, finishCall, logSse, startCall, type CallEntry } from './inspector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
  publish_date: string;
  source_type: 'web' | 'pdf' | string;
  metadata: {
    website?: string;
    categories?: string[];
    tags?: string[];
    original_filename?: string;
  };
}

export interface SearchResultsEvent {
  type: 'results';
  items: SearchResult[];
  total: number;
  page: number;
  pages: number;
}

/** A filter control to render. `options` is populated from facet values. */
export interface FilterDef {
  field: string;
  label: string;
  /**
   * `select` / `multiselect` / `keyword` render a dropdown of facet values;
   * `text` a free-text input; `date_range` / `range` a date range.
   */
  type: string;
  order?: number;
  description?: string;
  cardinality?: string;
  options?: string[];
}

export interface FacetHit {
  value: string;
  count: number;
}

export interface FacetResponse {
  collection_name?: string;
  key?: string;
  hits: FacetHit[];
}

/** Filter types whose options come from the facet index. */
const DROPDOWN_TYPES = new Set(['select', 'multiselect', 'keyword']);
export const isDropdownFilter = (type: string) => DROPDOWN_TYPES.has(type);

/** Filter types rendered as a date range (two `_from`/`_to` keys). */
const DATE_TYPES = new Set(['date_range', 'range']);
export const isDateFilter = (type: string) => DATE_TYPES.has(type);

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

/**
 * Empty `apiBaseUrl` means "use the dev server proxy at /api", which keeps the
 * browser same-origin and sidesteps CORS. Set it to the API's public origin to
 * exercise the real cross-origin path.
 */
function base() {
  return config.apiBaseUrl || '/api';
}

function collectionUrl(path: string) {
  const { orgId, collectionId } = config;
  return `${base()}/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(collectionId)}${path}`;
}

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${config.apiKey}`, ...extra };
}

/**
 * The API reports problems as `{"detail": "..."}` (FastAPI's convention). Fall
 * back through the other shapes rather than showing a bare status code.
 */
async function errorDetail(response: Response, fallback: string) {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text);
    return parsed.detail || parsed.error || parsed.message || fallback;
  } catch {
    return text ? text.slice(0, 300) : fallback;
  }
}

/** 429 carries Retry-After; surfacing it makes the limit self-explanatory. */
function rateLimitNote(response: Response) {
  const retryAfter = response.headers.get('retry-after');
  return retryAfter ? ` Retry after ${retryAfter}s.` : '';
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/**
 * Split a raw SSE buffer into complete `data:` payloads plus the trailing
 * partial line to carry into the next chunk.
 *
 * Exported for tests: a naive implementation that assumes each network chunk
 * ends on a line boundary corrupts tokens mid-word, which is the classic
 * streaming bug.
 */
export function parseSseChunk(buffer: string): { payloads: string[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const payloads: string[] = [];
  for (const line of lines) {
    // `:` comment lines are the server's keepalive — ignore them.
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (raw) payloads.push(raw);
  }
  return { payloads, rest };
}

/**
 * Read an SSE body to completion, dispatching each parsed JSON event.
 * `onEvent` returns false to stop early (e.g. after `done`).
 *
 * @returns true if the stream ended on its own, false if `onEvent` stopped it.
 */
export async function readSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: Record<string, unknown>, raw: string) => boolean,
): Promise<boolean> {
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return true;

    buffer += decoder.decode(value, { stream: true });
    const { payloads, rest } = parseSseChunk(buffer);
    buffer = rest;

    for (const raw of payloads) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw);
      } catch {
        continue; // Non-JSON line; nothing actionable.
      }
      if (!onEvent(event, raw)) return false;
    }
  }
}

async function postSse(
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<
  | { ok: true; reader: ReadableStreamDefaultReader<Uint8Array>; entry: CallEntry }
  | { ok: false; error: string }
> {
  const headers = authHeaders({ 'Content-Type': 'application/json' });
  const entry = startCall({ method: 'POST', url, headers, requestBody: body });

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const detail =
      (await errorDetail(response, `Request failed (${response.status})`)) +
      (response.status === 429 ? rateLimitNote(response) : '');
    finishCall(entry, { status: response.status, error: detail });
    return { ok: false, error: detail };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const error = 'Streaming not supported in this browser';
    finishCall(entry, { status: response.status, error });
    return { ok: false, error };
  }

  finishCall(entry, { status: response.status });
  return { ok: true, reader, entry };
}

// ---------------------------------------------------------------------------
// external-search (SSE)
// ---------------------------------------------------------------------------

export interface StreamSearchParams {
  query: string;
  page?: number;
  /**
   * Flat `field -> value` map. Date ranges use two keys, `${field}_from` and
   * `${field}_to`, each `YYYY-MM-DD`.
   */
  filters?: Record<string, string>;
  /**
   * True returns only the next page of results, skipping LLM summary
   * regeneration. This is how pagination avoids paying for a second summary.
   */
  skipSummary?: boolean;
  signal?: AbortSignal;
  onResults: (event: SearchResultsEvent) => void;
  onToken: (token: string) => void;
  onStatus?: (status: string) => void;
  onError: (error: string) => void;
  onDone: (fullSummary: string) => void;
}

export async function streamSearch({
  query,
  page = 1,
  filters,
  skipSummary = false,
  signal,
  onResults,
  onToken,
  onStatus,
  onError,
  onDone,
}: StreamSearchParams): Promise<void> {
  // `query` is capped at 2 000 chars server-side (422 beyond that).
  const url = collectionUrl('/external-search');

  try {
    const result = await postSse(
      url,
      { query, page, filters, skip_summary: skipSummary },
      signal,
    );
    if (!result.ok) {
      onError(result.error);
      return;
    }

    let fullSummary = '';
    const streamEnded = await readSse(result.reader, (event, raw) => {
      logSse(result.entry, raw);

      if (event.error) {
        onError(String(event.error));
        return false;
      }
      switch (event.type) {
        case 'results':
          onResults(event as unknown as SearchResultsEvent);
          return true;
        case 'status':
          if (event.text) onStatus?.(String(event.text));
          return true;
        case 'text':
          if (event.text) {
            fullSummary += String(event.text);
            onToken(String(event.text));
          }
          return true;
        case 'done':
          onDone(fullSummary.trim());
          return false;
        default:
          return true;
      }
    });

    // Some proxies drop the connection before `done` arrives; treat an
    // exhausted stream as completion rather than hanging the spinner.
    if (streamEnded) onDone(fullSummary.trim());
  } catch (err) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// external-chat (SSE)
// ---------------------------------------------------------------------------

export interface StreamChatParams {
  message: string;
  /**
   * Omit on the first turn; the server mints one and returns it on `start`
   * (and again on `done`). Echo it back on later turns and the server hydrates
   * history from storage — the client never resends the transcript.
   */
  conversationId?: string;
  /** Search results text used to seed a "dive deeper" conversation. */
  searchContext?: string;
  /** The originating search query, for seeded conversations. */
  seedQuery?: string;
  signal?: AbortSignal;
  onToken: (token: string) => void;
  onStatus?: (status: string) => void;
  onError: (error: string) => void;
  onDone: (fullMessage: string, conversationId: string) => void;
}

export async function streamChat({
  message,
  conversationId,
  searchContext,
  seedQuery,
  signal,
  onToken,
  onStatus,
  onError,
  onDone,
}: StreamChatParams): Promise<void> {
  // `message` is capped at 10 000 chars, `search_context` at 50 000.
  const url = collectionUrl('/external-chat');

  try {
    const result = await postSse(
      url,
      {
        message,
        conversation_id: conversationId || undefined,
        search_context: searchContext || undefined,
        seed_query: seedQuery || undefined,
      },
      signal,
    );
    if (!result.ok) {
      onError(result.error);
      return;
    }

    let fullMessage = '';
    let resolvedConversationId = conversationId || '';

    const streamEnded = await readSse(result.reader, (event, raw) => {
      logSse(result.entry, raw);

      if (event.error) {
        onError(String(event.error));
        return false;
      }
      if (event.conversation_id) {
        resolvedConversationId = String(event.conversation_id);
      }
      switch (event.type) {
        case 'start':
          // Older builds sent the id as `id`; prefer `conversation_id`.
          if (!event.conversation_id && event.id) {
            resolvedConversationId = String(event.id);
          }
          return true;
        case 'status':
          if (event.text) onStatus?.(String(event.text));
          return true;
        case 'text':
          if (event.text) {
            fullMessage += String(event.text);
            onToken(String(event.text));
          }
          return true;
        case 'done':
          onDone(fullMessage.trim(), resolvedConversationId);
          return false;
        default:
          return true;
      }
    });

    if (streamEnded) onDone(fullMessage.trim(), resolvedConversationId);
  } catch (err) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// facet + filter discovery (JSON)
// ---------------------------------------------------------------------------

async function getJson<T>(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; data?: T; error?: string }> {
  const headers = authHeaders();
  const entry = startCall({ method: 'GET', url, headers });

  try {
    const response = await fetch(url, { method: 'GET', headers, signal });
    if (!response.ok) {
      const detail =
        (await errorDetail(response, `Request failed (${response.status})`)) +
        (response.status === 429 ? rateLimitNote(response) : '');
      finishCall(entry, { status: response.status, error: detail });
      return { status: response.status, error: detail };
    }
    const data = (await response.json()) as T;
    finishCall(entry, { status: response.status, responseBody: data });
    return { status: response.status, data };
  } catch (err) {
    // An abort is the caller changing its mind, not a failure — drop the entry
    // so the log shows only real traffic.
    if (signal?.aborted) {
      dropCall(entry);
      throw err;
    }
    const error = err instanceof Error ? err.message : String(err);
    finishCall(entry, { error });
    throw err;
  }
}

/**
 * Facet values for one field. The field must be declared in the collection's
 * `external_chat_filters`, otherwise the API returns 403 — that is a
 * configuration signal, not a transient failure.
 */
export async function getFacet(
  field: string,
  opts: { limit?: number; exact?: boolean; signal?: AbortSignal } = {},
): Promise<FacetHit[]> {
  const params = new URLSearchParams({
    field,
    limit: String(opts.limit ?? 100),
    exact: String(opts.exact ?? false),
  });
  const result = await getJson<FacetResponse>(
    collectionUrl(`/external-chat/facet?${params}`),
    opts.signal,
  );
  if (result.error) throw new Error(result.error);
  return result.data?.hits ?? [];
}

interface DiscoveredFilterValue {
  value: string;
  count?: number | null;
}

interface DiscoveredFilter {
  field: string;
  label: string;
  type: string;
  order?: number;
  description?: string | null;
  cardinality?: string | null;
  values?: DiscoveredFilterValue[] | null;
}

export interface LoadFiltersResult {
  filters: FilterDef[];
  /**
   * `discovery` — definitions came from GET /external-chat/filters.
   * `local` — that endpoint was unavailable, so the locally configured
   * definitions were used instead.
   */
  source: 'discovery' | 'local';
  /** Per-field facet errors, keyed by field. */
  errorsByField: Record<string, string>;
}

async function hydrateDropdownOptions(
  filters: FilterDef[],
  errorsByField: Record<string, string>,
  signal?: AbortSignal,
) {
  await Promise.all(
    filters.map(async (f) => {
      if (!isDropdownFilter(f.type) || f.options?.length) return;
      try {
        f.options = (await getFacet(f.field, { signal })).map((h) => h.value);
      } catch (err) {
        // One misconfigured field must not blank the whole filter bar.
        errorsByField[f.field] = err instanceof Error ? err.message : String(err);
      }
    }),
  );
}

/**
 * Load the filter controls to render.
 *
 * Prefers `GET /external-chat/filters?include_values=true`, which returns the
 * definitions *and* their values in one round trip — the endpoint that makes a
 * headless client independent of the admin UI.
 *
 * That endpoint is newer than the rest of the embed API. When it is missing
 * (404) the client falls back to its own declared filters plus one `/facet`
 * call per dropdown field, which is exactly what the iframe does. Either way
 * the caller gets the same shape.
 */
export async function loadFilters(
  localFilters: FilterDef[],
  signal?: AbortSignal,
): Promise<LoadFiltersResult> {
  const errorsByField: Record<string, string> = {};

  const discovery = await getJson<{ filters: DiscoveredFilter[] }>(
    collectionUrl('/external-chat/filters?include_values=true&limit=100'),
    signal,
  ).catch(() => undefined);

  if (discovery?.data?.filters) {
    const filters: FilterDef[] = discovery.data.filters
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((f) => ({
        field: f.field,
        label: f.label,
        type: f.type,
        order: f.order,
        description: f.description ?? undefined,
        cardinality: f.cardinality ?? undefined,
        options: f.values?.map((v) => v.value),
      }));

    // `include_values` skips fields the facet index could not answer, so top up
    // any dropdown that came back without options.
    await hydrateDropdownOptions(filters, errorsByField, signal);
    return { filters, source: 'discovery', errorsByField };
  }

  const filters: FilterDef[] = localFilters.map((f) => ({ ...f }));
  await hydrateDropdownOptions(filters, errorsByField, signal);
  return { filters, source: 'local', errorsByField };
}
