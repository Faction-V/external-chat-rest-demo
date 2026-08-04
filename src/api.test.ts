import { describe, expect, it } from 'vitest';

import { parseSseChunk, readSse } from './api';

/** Feed a fixed list of string chunks through the reader interface. */
function readerFrom(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    read: async () =>
      i < chunks.length
        ? { done: false, value: encoder.encode(chunks[i++]) }
        : { done: true, value: undefined },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

describe('parseSseChunk', () => {
  it('returns complete data payloads and keeps the partial tail', () => {
    const { payloads, rest } = parseSseChunk('data: {"a":1}\ndata: {"b":2}\ndata: {"c"');
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('data: {"c"');
  });

  it('ignores keepalive comments and blank data lines', () => {
    const { payloads } = parseSseChunk(': keepalive\ndata: \ndata: {"ok":true}\n');
    expect(payloads).toEqual(['{"ok":true}']);
  });
});

describe('readSse', () => {
  it('reassembles an event split across chunk boundaries', async () => {
    const events: Record<string, unknown>[] = [];
    const ended = await readSse(
      readerFrom(['data: {"type":"text","te', 'xt":"hello"}\n']),
      (event) => {
        events.push(event);
        return true;
      },
    );

    expect(ended).toBe(true);
    expect(events).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('stops early when the callback returns false', async () => {
    const seen: string[] = [];
    const ended = await readSse(
      readerFrom(['data: {"type":"done"}\ndata: {"type":"text","text":"after"}\n']),
      (event) => {
        seen.push(String(event.type));
        return event.type !== 'done';
      },
    );

    // false => the caller stopped it, and nothing after `done` was dispatched.
    expect(ended).toBe(false);
    expect(seen).toEqual(['done']);
  });

  it('skips malformed JSON instead of throwing', async () => {
    const events: Record<string, unknown>[] = [];
    await readSse(readerFrom(['data: not-json\ndata: {"type":"done"}\n']), (event) => {
      events.push(event);
      return true;
    });

    expect(events).toEqual([{ type: 'done' }]);
  });
});
