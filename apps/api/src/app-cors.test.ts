import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Express } from 'express';
import { createApp, getAllowedOrigins } from './app';

async function withListeningApp(
  app: Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

test('attesta preflight allows the idempotency and request-id headers', async () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = 'https://console.example';
  try {
    const origin = getAllowedOrigins()[0];
    await withListeningApp(createApp(), async baseUrl => {
      const response = await fetch(`${baseUrl}/api/attesta/evidence-packs`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'idempotency-key,x-request-id,authorization,content-type',
        },
      });
      const allowed = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      for (const header of ['idempotency-key', 'x-request-id', 'authorization', 'content-type']) {
        assert.ok(allowed.includes(header), `preflight allows ${header}: ${allowed}`);
      }
    });
  } finally {
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
  }
});

test('responses expose the request id for the console', async () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = 'https://console.example';
  try {
    const origin = getAllowedOrigins()[0];
    await withListeningApp(createApp(), async baseUrl => {
      const response = await fetch(`${baseUrl}/health`, { headers: { origin } });
      assert.equal(response.status, 200);
      const exposed = (response.headers.get('access-control-expose-headers') ?? '').toLowerCase();
      assert.ok(exposed.includes('x-request-id'), `health exposes X-Request-ID: ${exposed}`);
    });
  } finally {
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
  }
});
