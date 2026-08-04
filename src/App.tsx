import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  Loader2,
  MessageSquareShare,
  PanelRightOpen,
  Search,
  Send,
} from 'lucide-react';

import {
  loadFilters,
  streamChat,
  streamSearch,
  type FilterDef,
  type SearchResult,
  type SearchResultsEvent,
} from './api';
import { config } from './config';
import { FilterBar, InspectorPanel, Markdown, ResultCard, SummaryCard } from './components';

// ---------------------------------------------------------------------------
// Presentation plumbing (mirrors the iframe's use-embed-styles hook)
// ---------------------------------------------------------------------------

/**
 * Operator CSS is configuration, not code — strip the constructs that turn a
 * stylesheet into an execution or exfiltration vector before injecting it.
 */
function sanitizeCss(css: string) {
  return css
    .replace(/@import\b[^;]*;?/gi, '/* @import removed */')
    .replace(/expression\s*\(/gi, '/* expression( removed */')
    .replace(/javascript\s*:/gi, '/* javascript: removed */');
}

function useEmbedStyles() {
  const { headerFont, headerFontWeight, bodyFont, bodyFontWeight, customCss } = config;

  useEffect(() => {
    const families = (
      [
        [headerFont, headerFontWeight],
        [bodyFont, bodyFontWeight],
      ] as [string, string][]
    )
      .filter(([family]) => family)
      .map(([family, weight]) => {
        const name = family.replace(/ /g, '+');
        return weight ? `${name}:wght@${weight}` : name;
      })
      .join('&family=');
    if (!families) return;

    const id = 'demo-google-fonts';
    let link = document.getElementById(id) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = `https://fonts.googleapis.com/css2?family=${families}&display=swap`;
  }, [headerFont, headerFontWeight, bodyFont, bodyFontWeight]);

  useEffect(() => {
    const id = 'demo-custom-css';
    let style = document.getElementById(id) as HTMLStyleElement | null;
    if (!customCss) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.appendChild(style);
    }
    style.textContent = sanitizeCss(customCss);
  }, [customCss]);
}

const contentWidthClass = config.contentMaxWidth ? '' : 'max-w-2xl';
const contentWidthStyle = config.contentMaxWidth
  ? { maxWidth: config.contentMaxWidth }
  : undefined;

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming: boolean;
  status?: string;
}

interface ChatViewProps {
  seedQuery?: string;
  seedSummary?: string;
  searchContext?: string;
}

const ChatView = ({ seedQuery, seedSummary, searchContext }: ChatViewProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (seedQuery && seedSummary) {
      return [
        { id: 'seed-user', role: 'user', content: seedQuery, isStreaming: false },
        {
          id: 'seed-assistant',
          role: 'assistant',
          content: seedSummary,
          isStreaming: false,
        },
      ];
    }
    if (config.greeting) {
      return [
        { id: 'greeting', role: 'assistant', content: config.greeting, isStreaming: false },
      ];
    }
    return [];
  });
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();

  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);

  // Only autoscroll when the reader is already at the bottom, otherwise
  // streaming yanks the viewport away from what they were reading.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    if (nearBottom) endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || sendingRef.current) return;

    sendingRef.current = true;
    setInput('');
    setIsLoading(true);

    const assistantId = `assistant-${crypto.randomUUID()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${crypto.randomUUID()}`,
        role: 'user',
        content: trimmed,
        isStreaming: false,
      },
      { id: assistantId, role: 'assistant', content: '', isStreaming: true },
    ]);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const patch = (id: string, fn: (msg: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));

    await streamChat({
      message: trimmed,
      conversationId,
      // Seed context belongs to the first turn only; afterwards the server
      // hydrates history from conversation_id.
      searchContext: conversationId ? undefined : searchContext,
      seedQuery: conversationId ? undefined : seedQuery,
      signal: controller.signal,
      onToken: (token) =>
        patch(assistantId, (m) => ({ ...m, content: m.content + token, status: undefined })),
      onStatus: (status) => patch(assistantId, (m) => ({ ...m, status })),
      onError: (error) => {
        patch(assistantId, (m) => ({
          ...m,
          content: m.content || `Sorry, something went wrong. ${error}`,
          isStreaming: false,
        }));
        sendingRef.current = false;
        setIsLoading(false);
      },
      onDone: (_full, newConversationId) => {
        setConversationId(newConversationId || undefined);
        patch(assistantId, (m) => ({ ...m, isStreaming: false }));
        sendingRef.current = false;
        setIsLoading(false);
      },
    });
  }, [input, conversationId, searchContext, seedQuery]);

  return (
    <div className='flex h-full flex-col'>
      <div ref={scrollRef} className='flex-1 overflow-y-auto px-4 py-4'>
        <div className={`mx-auto space-y-4 ${contentWidthClass}`} style={contentWidthStyle}>
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] px-4 py-2.5 text-sm ${msg.role === 'user' ? 'bg-black/5' : ''}`}
                style={{ color: config.fontColor, borderRadius: config.borderRadius }}
              >
                {msg.role === 'assistant' ? (
                  <>
                    {msg.status && !msg.content && (
                      <div className='flex items-center gap-2 py-1'>
                        <Loader2 className='size-4 animate-spin opacity-50' />
                        <span className='text-xs italic opacity-60'>{msg.status}</span>
                      </div>
                    )}
                    {msg.content ? (
                      <div className='prose prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0'>
                        <Markdown linkColor={config.linkColor}>{msg.content}</Markdown>
                      </div>
                    ) : msg.isStreaming && !msg.status ? (
                      <div className='flex items-center gap-2 py-1'>
                        <Loader2 className='size-4 animate-spin text-gray-400' />
                        <span className='text-xs text-gray-400'>Thinking...</span>
                      </div>
                    ) : null}
                    {msg.isStreaming && msg.content && (
                      <span className='inline-block size-1.5 animate-pulse rounded-full bg-gray-400 align-middle' />
                    )}
                  </>
                ) : (
                  <p className='whitespace-pre-wrap'>{msg.content}</p>
                )}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>

      <div
        className='shrink-0 border-t px-4 py-3'
        style={{ backgroundColor: config.bgColor, borderColor: config.fontColor + '20' }}
      >
        <div
          className={`mx-auto flex items-end gap-2 ${contentWidthClass}`}
          style={contentWidthStyle}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder='Type a message...'
            rows={1}
            disabled={isLoading}
            className='flex-1 resize-none border px-4 py-2.5 text-sm outline-none transition-colors disabled:opacity-50'
            style={{
              color: config.searchTextColor || config.fontColor,
              borderColor: config.fontColor + '30',
              backgroundColor: config.searchBgColor || config.fontColor + '08',
              borderRadius: config.borderRadius,
            }}
          />
          <button
            type='button'
            onClick={() => void handleSend()}
            disabled={!input.trim() || isLoading}
            className='flex size-10 shrink-0 items-center justify-center text-white transition-opacity disabled:opacity-40'
            style={{
              backgroundColor: config.primaryColor,
              borderRadius: config.borderRadius,
            }}
            aria-label='Send message'
          >
            <Send className='size-4' />
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const SearchView = () => {
  const [filters, setFilters] = useState<FilterDef[]>(config.filters);
  const [filtersLoading, setFiltersLoading] = useState(true);
  const [filterErrors, setFilterErrors] = useState<Record<string, string>>({});
  const [filterSource, setFilterSource] = useState<'discovery' | 'local'>('local');
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});

  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [summary, setSummary] = useState('');
  const [summaryStatus, setSummaryStatus] = useState<string | undefined>();
  const [isSummaryStreaming, setIsSummaryStreaming] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | undefined>();

  const [chat, setChat] = useState<ChatViewProps | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Filter discovery on mount. Values always come from the live index — values
  // baked into a page at build time drift the moment content is ingested.
  useEffect(() => {
    const controller = new AbortController();
    setFiltersLoading(true);
    loadFilters(config.filters, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setFilters(result.filters);
        setFilterErrors(result.errorsByField);
        setFilterSource(result.source);
      })
      .finally(() => {
        if (!controller.signal.aborted) setFiltersLoading(false);
      });
    return () => controller.abort();
  }, []);

  const activeFilters = useMemo(() => {
    const active: Record<string, string> = {};
    for (const [key, value] of Object.entries(filterValues)) {
      if (value) active[key] = value;
    }
    return active;
  }, [filterValues]);

  const runSearch = useCallback(
    async (page: number, skipSummary: boolean) => {
      const trimmed = query.trim();
      if (!trimmed || isSearching) return;

      setIsSearching(true);
      setHasSearched(true);
      setResults([]);
      setSearchError(undefined);
      // Pagination keeps the existing summary on screen; the server honours
      // skip_summary and returns results only.
      if (!skipSummary) {
        setSummary('');
        setSummaryStatus(undefined);
        setIsSummaryStreaming(true);
      }
      setCurrentPage(page);

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      await streamSearch({
        query: trimmed,
        page,
        filters: Object.keys(activeFilters).length > 0 ? activeFilters : undefined,
        skipSummary,
        signal: controller.signal,
        onResults: (data: SearchResultsEvent) => {
          setResults(data.items);
          setTotalResults(data.total);
          setTotalPages(data.pages);
          setCurrentPage(data.page);
          setIsSearching(false);
        },
        onToken: (token) => {
          if (skipSummary) return;
          setSummary((prev) => prev + token);
          setSummaryStatus(undefined);
        },
        onStatus: (status) => {
          if (skipSummary) return;
          setSummaryStatus(status);
        },
        onError: (error) => {
          setSearchError(error || 'Search failed. Please try again.');
          setIsSearching(false);
          if (!skipSummary) setIsSummaryStreaming(false);
        },
        onDone: () => {
          if (!skipSummary) setIsSummaryStreaming(false);
        },
      });
    },
    [query, isSearching, activeFilters],
  );

  const handleExport = useCallback(() => {
    if (results.length === 0) return;
    const body = results.map((r) => `${r.title}\n${r.url}\n${r.snippet}\n`).join('\n---\n\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `search-results-${query.slice(0, 30).replace(/\s+/g, '-')}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [results, query]);

  if (chat) {
    return (
      <div className='flex h-full flex-col'>
        <header
          className='flex shrink-0 items-center gap-2 px-4 py-3 text-white shadow-sm'
          style={{ backgroundColor: config.primaryColor }}
        >
          <button onClick={() => setChat(null)} className='p-1 hover:opacity-80'>
            <ArrowLeft className='size-5' />
          </button>
          <MessageSquareShare className='size-5' />
          <h1
            className='text-sm font-semibold'
            style={{
              fontFamily: config.headerFont || undefined,
              fontWeight: config.headerFontWeight || undefined,
            }}
          >
            Dive Deeper
          </h1>
        </header>
        <div className='min-h-0 flex-1'>
          <ChatView {...chat} />
        </div>
      </div>
    );
  }

  return (
    <div className='flex h-full flex-col'>
      <header
        className='flex shrink-0 items-center gap-2 px-4 py-3 text-white shadow-sm'
        style={{ backgroundColor: config.primaryColor }}
      >
        <Search className='size-5' />
        <h1
          className='text-sm font-semibold'
          style={{
            fontFamily: config.headerFont || undefined,
            fontWeight: config.headerFontWeight || undefined,
          }}
        >
          {config.title}
        </h1>
        <span className='ml-2 rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider'>
          REST
        </span>
      </header>

      <div
        className='shrink-0 border-b px-4 py-3'
        style={{ borderColor: config.fontColor + '15' }}
      >
        <div className={`mx-auto ${contentWidthClass}`} style={contentWidthStyle}>
          <div className='flex items-center gap-2'>
            <div className='relative flex-1'>
              <Search className='absolute left-3 top-1/2 size-4 -translate-y-1/2 opacity-30' />
              <input
                ref={inputRef}
                type='text'
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void runSearch(1, false);
                  }
                }}
                placeholder='Search...'
                className='w-full border py-2.5 pl-10 pr-4 text-sm outline-none'
                style={{
                  color: config.searchTextColor || config.fontColor,
                  borderColor: config.fontColor + '25',
                  backgroundColor: config.searchBgColor || config.fontColor + '05',
                  borderRadius: config.borderRadius,
                }}
              />
            </div>
            <button
              onClick={() => void runSearch(1, false)}
              disabled={!query.trim() || isSearching}
              className='flex size-10 shrink-0 items-center justify-center text-white transition-opacity disabled:opacity-40'
              style={{
                backgroundColor: config.primaryColor,
                borderRadius: config.borderRadius,
              }}
              aria-label='Run search'
            >
              {isSearching ? (
                <Loader2 className='size-4 animate-spin' />
              ) : (
                <Search className='size-4' />
              )}
            </button>
          </div>

          {filters.length > 0 && (
            <div className='mt-2'>
              <FilterBar
                filters={filters}
                values={filterValues}
                onChange={(field, value) =>
                  setFilterValues((prev) => ({ ...prev, [field]: value }))
                }
                fontColor={config.fontColor}
                borderRadius={config.borderRadius}
                loading={filtersLoading}
                errorsByField={filterErrors}
              />
              <p className='mt-1 text-[10px] opacity-40'>
                {filtersLoading
                  ? 'Loading filter definitions…'
                  : filterSource === 'discovery'
                    ? 'Filters from GET /external-chat/filters'
                    : 'Filters from local config + GET /external-chat/facet (discovery endpoint unavailable)'}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className='flex-1 overflow-y-auto px-4 py-4'>
        <div className={`mx-auto space-y-4 ${contentWidthClass}`} style={contentWidthStyle}>
          {!hasSearched && (
            <div className='flex h-full items-center justify-center pt-20'>
              <p className='text-sm opacity-40'>Enter a query to search.</p>
            </div>
          )}

          {hasSearched && (
            <>
              {searchError && (
                <div
                  className='border px-3 py-2 text-sm'
                  style={{
                    borderColor: '#dc262640',
                    backgroundColor: '#dc26260a',
                    color: '#b91c1c',
                    borderRadius: config.borderRadius,
                  }}
                  role='alert'
                >
                  {searchError}
                </div>
              )}

              {!searchError &&
                !isSearching &&
                !isSummaryStreaming &&
                results.length === 0 &&
                !summary && (
                  <div className='flex items-center justify-center pt-10'>
                    <p className='text-sm opacity-50'>
                      No results found for &ldquo;{query}&rdquo;.
                    </p>
                  </div>
                )}

              {(summary || summaryStatus || isSummaryStreaming) && (
                <SummaryCard
                  summary={summary}
                  isStreaming={isSummaryStreaming}
                  status={summaryStatus}
                  primaryColor={config.primaryColor}
                  linkColor={config.linkColor}
                  fontColor={config.fontColor}
                  borderRadius={config.borderRadius}
                  onDiveDeeper={() =>
                    setChat({
                      seedQuery: query,
                      seedSummary: summary,
                      searchContext: results
                        .map((r) => `## ${r.title}\nURL: ${r.url}\n${r.snippet}`)
                        .join('\n\n'),
                    })
                  }
                />
              )}

              {results.length > 0 && (
                <div className='flex items-center justify-between'>
                  <span className='text-xs opacity-50'>
                    {totalResults} results (page {currentPage} of {totalPages})
                  </span>
                  <button
                    onClick={handleExport}
                    className='flex items-center gap-1 rounded-md px-2 py-1 text-xs opacity-50 transition-opacity hover:opacity-80'
                  >
                    <Download className='size-3' />
                    Export
                  </button>
                </div>
              )}

              {isSearching && results.length === 0 && !isSummaryStreaming && (
                <div
                  className='flex items-center justify-center gap-2 py-6 text-xs opacity-60'
                  role='status'
                  aria-live='polite'
                >
                  <Loader2 className='size-4 animate-spin' />
                  <span>Loading results...</span>
                </div>
              )}

              <div className='space-y-2'>
                {results.map((result, index) => (
                  <ResultCard
                    key={`${result.title}-${index}`}
                    result={result}
                    fontColor={config.fontColor}
                    linkColor={config.linkColor}
                    borderRadius={config.borderRadius}
                  />
                ))}
              </div>

              {totalPages > 1 && (
                <div className='flex items-center justify-center gap-2 pt-2'>
                  <button
                    disabled={currentPage <= 1 || isSearching}
                    onClick={() => void runSearch(currentPage - 1, true)}
                    className='border px-3 py-1.5 text-xs disabled:opacity-30'
                    style={{
                      borderColor: config.fontColor + '25',
                      borderRadius: config.borderRadius,
                    }}
                  >
                    Previous
                  </button>
                  <span className='flex items-center gap-1.5 text-xs opacity-50'>
                    {isSearching && <Loader2 className='size-3 animate-spin' />}
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    disabled={currentPage >= totalPages || isSearching}
                    onClick={() => void runSearch(currentPage + 1, true)}
                    className='border px-3 py-1.5 text-xs disabled:opacity-30'
                    style={{
                      borderColor: config.fontColor + '25',
                      borderRadius: config.borderRadius,
                    }}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const SetupNotice = ({ missing }: { missing: string[] }) => (
  <div className='flex h-full items-center justify-center bg-white p-8'>
    <div className='max-w-lg space-y-3 text-sm text-gray-700'>
      <h1 className='text-base font-semibold'>Configuration needed</h1>
      <p>
        Missing: <strong>{missing.join(', ')}</strong>
      </p>
      <p>
        Set <code className='rounded bg-gray-100 px-1'>VITE_ORG_ID</code> and{' '}
        <code className='rounded bg-gray-100 px-1'>VITE_COLLECTION_ID</code> in{' '}
        <code className='rounded bg-gray-100 px-1'>.env.local</code>, then pass the embed
        key on the URL:
      </p>
      <pre className='overflow-x-auto rounded bg-gray-100 p-3 text-xs'>
        http://localhost:5174/?apiKey=eak_your_key_here
      </pre>
      <p className='text-xs text-gray-500'>
        The key is public by design — it ships in the page, exactly as it does in the
        iframe&rsquo;s <code>?apiKey=</code> param. Lock it down with the key&rsquo;s
        allowed_domains and rate limit rather than by hiding it.
      </p>
    </div>
  </div>
);

export const App = () => {
  useEmbedStyles();
  const [inspectorOpen, setInspectorOpen] = useState(config.inspectorOpen);

  const missing = [
    !config.orgId && 'orgId',
    !config.collectionId && 'collectionId',
    !config.apiKey && 'apiKey',
  ].filter(Boolean) as string[];

  if (missing.length > 0) return <SetupNotice missing={missing} />;

  return (
    <div className='flex h-full'>
      <div
        className='relative min-w-0 flex-1'
        style={{
          backgroundColor: config.bgColor,
          color: config.fontColor,
          fontFamily: config.bodyFont || undefined,
          fontWeight: config.bodyFontWeight || undefined,
        }}
      >
        <SearchView />
        {!inspectorOpen && (
          <button
            onClick={() => setInspectorOpen(true)}
            className='absolute bottom-4 right-4 flex items-center gap-1.5 rounded-full bg-[#1e1e24] px-3 py-2 text-xs text-white shadow-lg hover:opacity-90'
          >
            <PanelRightOpen className='size-3.5' />
            REST traffic
          </button>
        )}
      </div>
      {inspectorOpen && <InspectorPanel onClose={() => setInspectorOpen(false)} />}
    </div>
  );
};
