# External Chat — REST API Demo

A working reference integration of the Capitol AI **external-chat REST API**, built
as a plain React app. It reproduces everything the iframe embed does — AI-summarised
search, faceted filters, pagination, and a follow-up chat that inherits the search
context — while calling the API directly instead of hosting an iframe.

It ships with a **REST traffic panel** that logs every request: URL, headers, body,
and each SSE event as it streams in. If you are integrating, that panel is the
fastest way to learn the contract.

---

## Quick start

```bash
npm install
cp .env.example .env.local   # set VITE_ORG_ID and VITE_COLLECTION_ID
npm run dev
```

Then open the app with your embed key on the URL:

```
http://localhost:5174/?apiKey=eak_your_key_here
```

The key is intentionally passed in the URL, the same way the iframe takes
`?apiKey=`. See [Securing the key](#securing-the-key).

---

## The API surface

Four endpoints, all under the API's **public** app and all authenticated with an
embed API key:

```
Authorization: Bearer eak_...
```

| Method | Path | Response | Purpose |
| ------ | ---- | -------- | ------- |
| `POST` | `/{orgid}/collections/{cid}/external-search` | SSE | Search + streamed AI summary |
| `POST` | `/{orgid}/collections/{cid}/external-chat` | SSE | Conversational follow-up |
| `GET` | `/{orgid}/collections/{cid}/external-chat/filters` | JSON | Filter definitions (+ optional values) |
| `GET` | `/{orgid}/collections/{cid}/external-chat/facet` | JSON | Values for one filter field |

Everything else on the collection — `external-chat/config`, `external-chat/keys`,
instruction versions — requires an **admin** credential (user JWT or M2M token) and
is *not* reachable with an embed key. Presentation config (title, colours, fonts,
custom CSS) is therefore supplied by your own page, exactly as the iframe receives
it baked into its URL. See [`src/config.ts`](src/config.ts).

### Search

```http
POST /{orgid}/collections/{cid}/external-search
Content-Type: application/json

{
  "query": "what is intelligent design?",
  "page": 1,
  "filters": { "source_type": "book" },
  "skip_summary": false
}
```

`query` is capped at 2 000 characters. The response is an SSE stream:

```
data: {"type": "status", "text": "Searching the collection…"}
data: {"type": "results", "items": [...], "total": 56, "page": 1, "pages": 6}
data: {"type": "text", "text": "Intelligent design is "}
data: {"type": "text", "text": "a scientific theory holding "}
data: {"type": "done"}
```

- `status` — transient progress text. Replace it with the next `text` token.
- `results` — the page of hits. Arrives **before** the summary, so render results
  immediately rather than waiting for the stream to finish.
- `text` — summary tokens, to be concatenated.
- `done` — terminal. An `error` event, or `{"error": "..."}`, is also terminal.

**Pagination.** Send the same query with the next `page` and `skip_summary: true`.
The server returns only the `results` event and skips summary generation, so you
neither pay for nor wait on a second LLM call. Keep the existing summary on screen.
In this demo an initial search emitted 41 SSE events; the paginated call emitted 2.

**Result shape:**

```json
{
  "title": "Not By Chance",
  "url": "https://example.org/article",
  "snippet": "…",
  "score": 0.82,
  "publish_date": "2020-12-18T00:00:00Z",
  "source_type": "web",
  "metadata": { "website": "example.org", "original_filename": null }
}
```

`publish_date` is ISO-8601. `source_type` is `web` or `pdf` for rendering purposes,
and may carry corpus-specific values (`book`, `video`, `paper`, …).

### Chat

```http
POST /{orgid}/collections/{cid}/external-chat

{
  "message": "Who is Michael Behe?",
  "conversation_id": "3f9c1a7e5b2d48c6a0e7d1b4c8f2a6e9",
  "search_context": "## Not By Chance\nURL: …\n…",
  "seed_query": "what is intelligent design?"
}
```

`message` is capped at 10 000 characters, `search_context` at 50 000.

**Conversation state lives on the server.** Omit `conversation_id` on the first
turn; the server mints one and returns it on the `start` event (and again on
`done`). Echo it on every later turn and the server hydrates the transcript from
storage — you never resend history. Send `search_context` and `seed_query` on the
**first** turn only; they seed a conversation from a search result set (the "Dive
deeper" flow).

Stream events are the same as search, minus `results`:

```
data: {"type": "start", "id": "msg_011…", "conversation_id": "3f9c1a7e…"}
data: {"type": "text", "text": "Michael Behe is a biochemist…"}
data: {"type": "done"}
```

> Server-side history is retained for the newest ~40 messages with a 7-day TTL, and
> there is currently **no** endpoint to read a conversation back. A page reload
> starts a fresh conversation.

### Filters

`GET …/external-chat/filters?include_values=true&limit=100` returns the filter
controls to render, values included — one round trip, no dependency on the admin UI:

```json
{
  "filters": [
    {
      "field": "source_type",
      "label": "Source Type",
      "type": "select",
      "order": 0,
      "cardinality": "single",
      "values": [{ "value": "book", "count": 34774 }]
    }
  ]
}
```

Use `field` as the key in the search `filters` object. `type` drives the control:
`select` / `multiselect` / `keyword` → dropdown, `text` → free text,
`date_range` / `range` → a date range sent as two keys, `{field}_from` and
`{field}_to`, each `YYYY-MM-DD`.

`GET …/external-chat/facet?field=source_type&limit=100` returns values for a single
field. Only fields declared as filters on the collection are permitted — anything
else is a `403`, which signals misconfiguration rather than a transient fault.

**Always fetch values live.** Baking them into your page freezes them at build time;
they drift the moment content is ingested or removed.

**Compatibility note.** `/filters` is newer than the rest of the embed API. This
client tries it first and, on `404`, falls back to its locally declared filters plus
one `/facet` call per dropdown — which is what the iframe does. The line under the
filter bar tells you which path was taken, so you can see the fallback working.

---

## Errors

| Status | Meaning |
| ------ | ------- |
| `401` | Missing, invalid, or revoked key |
| `403` | Key not scoped to this org/collection, `Origin` not in the key's allowlist, or facet on an undeclared field |
| `422` | Validation failure (e.g. `query` over its length cap) |
| `429` | Per-key or per-IP rate limit — honour the `Retry-After` header |

Bodies follow FastAPI's convention, `{"detail": "..."}`.

Two stream-level failure modes are easy to miss:

1. An `error` event can arrive **mid-stream**, after a `200`. A non-2xx check alone
   is not enough.
2. The connection can close without a `done` event (proxy timeout). Treat an
   exhausted stream as completion or the spinner never stops. See `readSse` in
   [`src/api.ts`](src/api.ts).

---

## Securing the key

An embed key is **public by design**: it ships in the page, exactly as it does in
the iframe's `?apiKey=` query string. Do not build on the assumption that it is
secret. Instead, constrain it per key:

- **`allowed_domains`** — hostnames permitted to call the stream endpoints from a
  browser, matched against `Origin`/`Referer`. `*.example.com` covers subdomains;
  declare the apex separately. Empty means any origin.
- **`rate_limit_per_minute`** — per-key ceiling; `0` uses the platform default.
  A separate per-IP limit applies regardless.

Both are set when creating the key or via `PATCH …/external-chat/keys/{key}`
(admin-authed).

## Browser transport and CORS

Two supported topologies, switched by one env var:

**Proxied (default).** `VITE_API_BASE_URL` unset: the app calls the relative path
`/api/...` and the dev server proxies to `VITE_PLATFORM_API_URL`. Same-origin, so no
preflight. Works against any build of the API. See the `server.proxy` block in
[`vite.config.ts`](vite.config.ts) — note `timeout: 0` and the socket-timeout
clearing, without which SSE streams get cut.

**Direct.** Set `VITE_API_BASE_URL` to the API's public origin and the browser calls
it cross-origin. This is the real production topology and it needs CORS on the API's
public app plus your host in the key's `allowed_domains`.

If you front the API with your own proxy or CDN instead, three things bite SSE:
disable response buffering, set the idle timeout above the stream's 15-second
keepalive, and consume the body with `fetch` + `ReadableStream` — `EventSource`
cannot send an `Authorization` header.

---

## Layout

| File | What's in it |
| ---- | ------------ |
| [`src/api.ts`](src/api.ts) | The whole client: SSE parsing, both streams, facets, filter discovery + fallback. **Start here.** |
| [`src/config.ts`](src/config.ts) | Config resolution — URL param > env > default, using the iframe's param names |
| [`src/App.tsx`](src/App.tsx) | Search and chat views, theming, custom-CSS injection |
| [`src/components.tsx`](src/components.tsx) | Filter bar, result card, summary card, REST inspector |
| [`src/inspector.ts`](src/inspector.ts) | In-memory call log behind the traffic panel |
| [`src/api.test.ts`](src/api.test.ts) | SSE parser tests, including a chunk split mid-token |

```bash
npm test        # vitest
npm run build   # tsc + vite build
```

## Theming

Every presentation value accepts a URL param, matching the iframe's names, so an
existing embed query string can be pasted onto this app unchanged:

`title`, `greeting`, `primaryColor`, `fontColor`, `bgColor`, `linkColor`,
`headerFont`, `headerFontWeight`, `bodyFont`, `bodyFontWeight`, `searchBgColor`,
`searchTextColor`, `customCss`, `borderRadius`, `contentMaxWidth`, `filters`.

`customCss` is injected after stripping `@import`, `expression(`, and `javascript:`.
This demo keeps the iframe's class names and ARIA labels (`.prose`, `bg-black/5`,
`space-y-2 > div`, `button[aria-label="Send message"]`) so existing operator CSS
keeps working. Add `?inspector=0` to hide the traffic panel.
