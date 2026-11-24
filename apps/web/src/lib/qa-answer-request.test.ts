import assert from 'node:assert/strict';
import { test } from 'node:test';

test('S7 answer request sends the selected breakdown and receives its buckets', async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-public-placeholder';
  const { supabase } = await import('./supabase');
  const { getQaAnswer } = await import('./api');
  const originalGetSession = supabase.auth.getSession;
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  try {
    supabase.auth.getSession = async () => ({ data: { session: { access_token: 'test-token' } }, error: null }) as never;
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      const selected = new URL(requestedUrl).searchParams.get('breakdown');
      return new Response(JSON.stringify({ figures: [{ key: 'findings', breakdown: selected === 'severity'
        ? [{ dimension: 'severity', key: 'high', value: { type: 'count', count: 2 } }] : [] }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const answer = await getQaAnswer('S7', {
      kind: 'live', from: '2026-11-01T00:00:00.000Z', to: '2026-11-25T00:00:00.000Z', breakdown: 'severity',
    });
    assert.equal(new URL(requestedUrl).searchParams.get('breakdown'), 'severity');
    assert.deepEqual(answer.figures[0].breakdown, [
      { dimension: 'severity', key: 'high', value: { type: 'count', count: 2 } },
    ]);
  } finally {
    supabase.auth.getSession = originalGetSession;
    globalThis.fetch = originalFetch;
  }
});
