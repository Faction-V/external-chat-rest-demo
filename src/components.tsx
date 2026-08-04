import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Loader2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';

import { isDateFilter, isDropdownFilter, type FilterDef, type SearchResult } from './api';
import { clearEntries, getEntries, subscribe, type CallEntry } from './inspector';

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * Links in model output open in a new tab and carry noopener — the summary
 * cites third-party sources, so it is untrusted content by definition.
 */
export const Markdown = ({
  children,
  linkColor,
}: {
  children: string;
  linkColor: string;
}) => (
  <ReactMarkdown
    components={{
      a: ({ href, children: text }) => (
        <a
          href={href}
          target='_blank'
          rel='noopener noreferrer'
          style={{ color: linkColor, textDecorationColor: linkColor + '50' }}
          className='underline underline-offset-2 hover:opacity-80'
        >
          {text}
        </a>
      ),
    }}
  >
    {children}
  </ReactMarkdown>
);

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

interface FilterBarProps {
  filters: FilterDef[];
  values: Record<string, string>;
  onChange: (field: string, value: string) => void;
  fontColor: string;
  borderRadius: string;
  loading: boolean;
  errorsByField: Record<string, string>;
}

export const FilterBar = ({
  filters,
  values,
  onChange,
  fontColor,
  borderRadius,
  loading,
  errorsByField,
}: FilterBarProps) => {
  if (filters.length === 0) return null;

  const inputStyle = {
    color: fontColor,
    borderColor: fontColor + '25',
    backgroundColor: fontColor + '05',
    borderRadius,
  };

  return (
    <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
      {filters.map((f) => {
        const dropdown = isDropdownFilter(f.type);
        const fieldError = dropdown ? errorsByField[f.field] : undefined;
        const options = f.options ?? [];
        const isEmpty = dropdown && !loading && !fieldError && options.length === 0;
        const placeholder = loading
          ? 'Loading…'
          : fieldError
            ? 'Unavailable'
            : isEmpty
              ? 'No values yet'
              : 'All';

        return (
          <div key={f.field} className='flex items-center gap-1.5'>
            {f.label && (
              <span className='text-xs font-semibold' style={{ color: fontColor }}>
                {f.label}:
              </span>
            )}

            {isDateFilter(f.type) ? (
              // Native date inputs instead of a picker library: same YYYY-MM-DD
              // payload, no extra dependency.
              <div className='flex items-center gap-1'>
                <input
                  type='date'
                  value={values[`${f.field}_from`] || ''}
                  onChange={(e) => onChange(`${f.field}_from`, e.target.value)}
                  className='border px-2 py-1.5 text-xs outline-none'
                  style={inputStyle}
                  aria-label={`${f.label || f.field} from`}
                />
                <span className='text-xs opacity-50'>–</span>
                <input
                  type='date'
                  value={values[`${f.field}_to`] || ''}
                  onChange={(e) => onChange(`${f.field}_to`, e.target.value)}
                  className='border px-2 py-1.5 text-xs outline-none'
                  style={inputStyle}
                  aria-label={`${f.label || f.field} to`}
                />
              </div>
            ) : dropdown ? (
              <select
                value={values[f.field] || ''}
                onChange={(e) => onChange(f.field, e.target.value)}
                disabled={loading || !!fieldError || isEmpty}
                className='border px-2.5 py-1.5 text-xs outline-none disabled:opacity-50'
                style={inputStyle}
                aria-label={f.label || f.field}
                title={fieldError || f.description || undefined}
              >
                <option value=''>{placeholder}</option>
                {options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type='text'
                value={values[f.field] || ''}
                onChange={(e) => onChange(f.field, e.target.value)}
                placeholder='All'
                className='border px-2.5 py-1.5 text-xs outline-none'
                style={inputStyle}
                aria-label={f.label || f.field}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------

function extractDomain(url: string) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}

export const ResultCard = ({
  result,
  fontColor,
  linkColor,
  borderRadius,
}: {
  result: SearchResult;
  fontColor: string;
  linkColor: string;
  borderRadius: string;
}) => {
  const label = useMemo(() => {
    if (result.source_type === 'web' && result.url) return extractDomain(result.url);
    return result.metadata?.original_filename || result.source_type || '';
  }, [result.source_type, result.url, result.metadata?.original_filename]);

  return (
    <a
      href={result.url || '#'}
      target='_blank'
      rel='noopener noreferrer'
      className='result-card block border p-3 transition-colors hover:bg-black/[0.02]'
      style={{ borderColor: fontColor + '15', borderRadius }}
    >
      <div className='flex items-start gap-2'>
        {result.source_type === 'pdf' ? (
          <FileText className='mt-0.5 size-4 shrink-0 opacity-40' />
        ) : (
          <ExternalLink className='mt-0.5 size-4 shrink-0 opacity-40' />
        )}
        <div className='min-w-0 flex-1'>
          <h3
            className='line-clamp-1 text-sm font-medium leading-snug'
            style={{ color: linkColor }}
          >
            {result.title}
          </h3>
          <p
            className='mt-0.5 line-clamp-2 text-xs leading-relaxed opacity-70'
            style={{ color: fontColor }}
          >
            {result.snippet}
          </p>
          <div className='mt-1.5 flex items-center gap-2 text-xs opacity-50'>
            <span>{label}</span>
            {result.publish_date && (
              <>
                <span>&middot;</span>
                <span>{new Date(result.publish_date).toLocaleDateString()}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </a>
  );
};

// ---------------------------------------------------------------------------
// AI summary
// ---------------------------------------------------------------------------

const COLLAPSED_MAX_HEIGHT = 180;

export const SummaryCard = ({
  summary,
  isStreaming,
  status,
  primaryColor,
  linkColor,
  fontColor,
  borderRadius,
  onDiveDeeper,
}: {
  summary: string;
  isStreaming: boolean;
  status?: string;
  primaryColor: string;
  linkColor: string;
  fontColor: string;
  borderRadius: string;
  onDiveDeeper: () => void;
}) => {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contentRef.current) return;
    setOverflows(contentRef.current.scrollHeight > COLLAPSED_MAX_HEIGHT);
  }, [summary]);

  const needsFade = overflows && !expanded;

  return (
    <div
      className='border p-4'
      style={{
        borderColor: primaryColor + '30',
        background: `linear-gradient(135deg, ${primaryColor}08, ${primaryColor}04)`,
        borderRadius,
      }}
    >
      <div className='mb-3 flex items-center gap-2'>
        <Sparkles className='size-4' style={{ color: primaryColor }} />
        <span
          className='text-xs font-semibold uppercase tracking-wide'
          style={{ color: primaryColor }}
        >
          AI Summary
        </span>
      </div>

      {status && !summary && (
        <div className='flex items-center gap-2 py-1'>
          <Loader2 className='size-4 animate-spin opacity-50' />
          <span className='text-xs italic opacity-60'>{status}</span>
        </div>
      )}

      {summary && (
        <div className='relative'>
          <div
            ref={contentRef}
            className='prose prose-sm max-w-none overflow-hidden [&>*:first-child]:mt-0 [&>*:last-child]:mb-0'
            style={{ maxHeight: expanded ? undefined : COLLAPSED_MAX_HEIGHT }}
          >
            <Markdown linkColor={linkColor}>{summary}</Markdown>
          </div>
          {needsFade && (
            <div
              className='pointer-events-none absolute inset-x-0 bottom-0 h-16'
              style={{
                background: `linear-gradient(to top, ${primaryColor}0a, transparent)`,
              }}
            />
          )}
        </div>
      )}

      {isStreaming && summary && (
        <span className='mt-1 inline-block size-1.5 animate-pulse rounded-full bg-gray-400 align-middle' />
      )}

      <div className='mt-3 flex items-center gap-2'>
        {overflows && (
          <button
            onClick={() => setExpanded(!expanded)}
            className='border px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-opacity hover:opacity-80'
            style={{ borderColor: fontColor + '20', color: fontColor + 'cc', borderRadius }}
          >
            {expanded ? 'Show less' : 'Read more'}
          </button>
        )}
        {!isStreaming && summary && (
          <button
            onClick={onDiveDeeper}
            className='px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90'
            style={{ backgroundColor: linkColor, borderRadius }}
          >
            Dive deeper
          </button>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// REST inspector
// ---------------------------------------------------------------------------

const statusColor = (entry: CallEntry) => {
  if (entry.error) return '#f87171';
  if (!entry.status) return '#9ca3af';
  if (entry.status >= 400) return '#f87171';
  return '#4ade80';
};

const Section = ({ title, children }: { title: string; children: string }) => (
  <div>
    <div className='mb-0.5 text-[9px] font-bold uppercase tracking-wider opacity-40'>
      {title}
    </div>
    <pre className='max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2'>
      {children}
    </pre>
  </div>
);

const CallRow = ({ entry }: { entry: CallEntry }) => {
  const [open, setOpen] = useState(false);
  // Strip the org/collection prefix so the endpoint shape reads at a glance.
  const shortUrl = entry.url.replace(/^.*\/collections\/[^/]+/, '…');

  return (
    <div className='border-b border-white/10'>
      <button
        onClick={() => setOpen(!open)}
        className='flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/5'
      >
        {open ? (
          <ChevronDown className='size-3 shrink-0 opacity-60' />
        ) : (
          <ChevronRight className='size-3 shrink-0 opacity-60' />
        )}
        <span className='w-10 shrink-0 font-mono text-[10px] font-bold opacity-70'>
          {entry.method}
        </span>
        <span className='min-w-0 flex-1 truncate font-mono text-[11px]'>{shortUrl}</span>
        <span
          className='shrink-0 font-mono text-[10px] font-bold'
          style={{ color: statusColor(entry) }}
        >
          {/* A status code is more informative than ERR; reserve ERR for
              failures that never got a response at all. */}
          {entry.status ?? (entry.error ? 'ERR' : '…')}
        </span>
        {entry.events.length > 0 && (
          <span className='shrink-0 rounded bg-white/10 px-1 font-mono text-[10px]'>
            {entry.events.length} ev
          </span>
        )}
        {entry.durationMs != null && (
          <span className='w-12 shrink-0 text-right font-mono text-[10px] opacity-50'>
            {entry.durationMs}ms
          </span>
        )}
      </button>

      {open && (
        <div className='space-y-2 bg-black/30 px-3 pb-3 pt-1 font-mono text-[10px] leading-relaxed'>
          <Section title='Request URL'>{entry.url}</Section>
          <Section title='Headers'>
            {Object.entries(entry.headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')}
          </Section>
          {entry.requestBody !== undefined && (
            <Section title='Request body'>
              {JSON.stringify(entry.requestBody, null, 2)}
            </Section>
          )}
          {entry.error && <Section title='Error'>{entry.error}</Section>}
          {entry.responseBody !== undefined && (
            <Section title='Response body'>
              {JSON.stringify(entry.responseBody, null, 2)}
            </Section>
          )}
          {entry.events.length > 0 && (
            <Section title={`SSE events (${entry.events.length})`}>
              {entry.events.map((e) => e.raw).join('\n')}
            </Section>
          )}
        </div>
      )}
    </div>
  );
};

export const InspectorPanel = ({ onClose }: { onClose: () => void }) => {
  const entries = useSyncExternalStore(subscribe, getEntries);

  return (
    <aside className='flex h-full w-[420px] shrink-0 flex-col border-l border-white/10 bg-[#1e1e24] text-gray-200'>
      <header className='flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2'>
        <span className='text-xs font-semibold uppercase tracking-wider'>REST traffic</span>
        <span className='rounded bg-white/10 px-1.5 font-mono text-[10px]'>
          {entries.length}
        </span>
        <div className='flex-1' />
        <button
          onClick={clearEntries}
          className='flex items-center gap-1 rounded px-1.5 py-1 text-[10px] opacity-60 hover:bg-white/10 hover:opacity-100'
          title='Clear log'
        >
          <Trash2 className='size-3' />
        </button>
        <button
          onClick={onClose}
          className='rounded px-1.5 py-1 text-[10px] opacity-60 hover:bg-white/10 hover:opacity-100'
        >
          Hide
        </button>
      </header>

      <div className='min-h-0 flex-1 overflow-y-auto'>
        {entries.length === 0 ? (
          <p className='p-3 text-[11px] opacity-40'>
            No calls yet. Every request this page makes to the external-chat API shows up
            here — URL, headers, body, and each SSE event as it streams in.
          </p>
        ) : (
          entries.map((entry) => <CallRow key={entry.id} entry={entry} />)
        )}
      </div>
    </aside>
  );
};
