/**
 * Demo configuration.
 *
 * Resolution order for every value: URL query param > Vite env var > built-in
 * default. The query-param names are deliberately identical to the iframe
 * embed's, so an existing embed URL's query string can be pasted onto this app
 * and produce the same look and behaviour.
 *
 * Note what is NOT here: there is no API call that returns branding. The
 * `/external-chat/config` endpoint is admin-authed (user JWT / M2M), not
 * embed-key-authed, so a headless integration supplies its own presentation
 * config — exactly as the iframe receives it baked into its URL.
 */

import type { FilterDef } from './api';

// Guarded so the module can be imported outside a browser (unit tests, SSR).
const params = new URLSearchParams(
  typeof window === 'undefined' ? '' : window.location.search,
);

/** URL param wins; then env; then the built-in default. */
function resolve(param: string, envValue: string | undefined, fallback: string) {
  const fromUrl = params.get(param);
  if (fromUrl !== null && fromUrl !== '') return fromUrl;
  if (envValue) return envValue;
  return fallback;
}

const DEFAULT_FILTERS: FilterDef[] = [
  { field: 'source_type', label: 'Source Type', type: 'select' },
  { field: 'author_names', label: 'Author', type: 'select' },
  { field: 'wp_site', label: 'Site', type: 'select' },
];

/**
 * Sample operator CSS, copied verbatim from the reference embed URL. It targets
 * the same selectors the iframe exposes, which is why this demo keeps those
 * class names and aria labels.
 */
const DEFAULT_CUSTOM_CSS = `/* Discovery Institute brand alignment */

/* Prose styling for AI responses */
.prose { font-size: 14px; line-height: 1.7; }
.prose p { margin-bottom: 0.75em; }
.prose h1, .prose h2, .prose h3 {
  font-family: 'Crimson Text', serif;
  color: #222;
  font-weight: 600;
}
.prose ul, .prose ol { padding-left: 1.25em; }
.prose li { margin-bottom: 0.25em; }
.prose blockquote {
  border-left: 3px solid #004FA2;
  padding-left: 1em;
  color: #555;
  font-style: italic;
}

/* User message bubbles */
div[class*="bg-black/5"] {
  background-color: #e8eff8 !important;
  border: 1px solid #d0dded;
}

/* Input area polish */
textarea {
  font-family: 'Open Sans', sans-serif !important;
  font-size: 14px !important;
}

/* Send button hover */
button[aria-label="Send message"]:hover {
  opacity: 0.85;
}

/* Search result cards */
[class*="space-y-2"] > div {
  border: 1px solid #e5e5e5;
  transition: border-color 0.15s;
}
[class*="space-y-2"] > div:hover {
  border-color: #004FA2;
}

/* Scrollbar styling */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #999; }`;

function parseFilters(): FilterDef[] {
  const raw = params.get('filters');
  if (!raw) return DEFAULT_FILTERS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FilterDef[]) : DEFAULT_FILTERS;
  } catch {
    // Malformed `filters` should not blank the UI — fall back to the defaults,
    // same forgiving behaviour as the iframe.
    return DEFAULT_FILTERS;
  }
}

const env = import.meta.env;

const primaryColor = resolve('primaryColor', undefined, '#2563eb');

export const config = {
  orgId: resolve('orgId', env.VITE_ORG_ID, ''),
  collectionId: resolve('collectionId', env.VITE_COLLECTION_ID, ''),
  apiKey: resolve('apiKey', env.VITE_EMBED_API_KEY, ''),

  /**
   * Empty = use the dev server's `/api` proxy (same-origin, no CORS).
   * Absolute origin = call the API directly from the browser, which needs CORS
   * on the public app plus this host in the key's allowed_domains.
   */
  apiBaseUrl: resolve('apiBaseUrl', env.VITE_API_BASE_URL, ''),

  title: resolve('title', undefined, 'Discovery Content'),
  greeting: resolve('greeting', undefined, 'Ask anything'),
  primaryColor,
  fontColor: resolve('fontColor', undefined, '#111827'),
  bgColor: resolve('bgColor', undefined, '#ffffff'),
  linkColor: resolve('linkColor', undefined, primaryColor),

  headerFont: resolve('headerFont', undefined, 'Crimson Text'),
  headerFontWeight: resolve('headerFontWeight', undefined, '400'),
  bodyFont: resolve('bodyFont', undefined, 'Open Sans'),
  bodyFontWeight: resolve('bodyFontWeight', undefined, ''),
  searchBgColor: resolve('searchBgColor', undefined, ''),
  searchTextColor: resolve('searchTextColor', undefined, ''),
  customCss: params.get('customCss') ?? DEFAULT_CUSTOM_CSS,
  // "0" is a meaningful value, so only an absent param falls back to 8px.
  borderRadius: params.get('borderRadius') ?? '8px',
  contentMaxWidth: resolve('contentMaxWidth', undefined, ''),

  filters: parseFilters(),

  /** Show the REST inspector panel by default. `?inspector=0` hides it. */
  inspectorOpen: params.get('inspector') !== '0',
};

export type DemoConfig = typeof config;
