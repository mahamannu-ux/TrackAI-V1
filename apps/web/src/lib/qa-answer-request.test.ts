import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

/**
 * supabase-js 2.110 builds its realtime client when the client is created and needs a
 * built-in WebSocket, which Node 20 (the CI runtime) does not have. This test never opens a
 * realtime connection, so a bare stand-in is enough; it is installed only when missing and
 * removed again, and the app itself always runs where WebSocket exists (the browser).
 */
function withWebSocketStandIn(): () => void {
  const scope = globalThis as { WebSocket?: unknown };
  if (scope.WebSocket !== undefined) return () => undefined;
  scope.WebSocket = class WebSocketStandIn {};
  return () => { delete scope.WebSocket; };
}

test('S7 answer request sends the selected breakdown and receives its buckets', async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-public-placeholder';
  const restoreWebSocket = withWebSocketStandIn();
  const { supabase } = await import('./supabase');
  restoreWebSocket();
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

test('every closed-list reason code in the Q&A contract has a plain message on the screen (Task19j)', async () => {
  const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../../docs/contracts/qa/answer-v1.schema.json'), 'utf8')) as {
    definitions: { reason: { properties: { code: { enum: string[] } } } };
  };
  const { QA_REASON_MESSAGES } = await import('../app/dashboard/questions-presentation');
  const codes = schema.definitions.reason.properties.code.enum;
  assert.ok(codes.includes('not_sealed_yet'));
  for (const code of codes) {
    assert.ok(QA_REASON_MESSAGES[code], `no message for ${code}`);
    assert.notEqual(QA_REASON_MESSAGES[code], code);
  }
});
