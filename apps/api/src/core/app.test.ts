import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express, { type Express, type RequestHandler } from 'express';
import { createApp, internalErrorHandler } from '../app';

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

test('worker evidence requests authenticate exactly once', async () => {
  let authenticationCalls = 0;
  const countAuthentication: RequestHandler = (req, _res, next) => {
    authenticationCalls += 1;
    req.tenantId = '11111111-1111-4111-8111-111111111111';
    next();
  };

  await withListeningApp(createApp({ machineAuthentication: countAuthentication }), async baseUrl => {
    const response = await fetch(`${baseUrl}/worker/evidence/opencode/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 400);
  });

  assert.equal(authenticationCalls, 1);
});

test('a thrown error returns no client details and keeps CORS origin behavior', async () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  process.env.FRONTEND_URL = 'https://frontend.example';
  console.error = (...values: unknown[]) => { logged.push(values); };

  try {
    const app = express();
    app.get('/throws', () => {
      throw new Error('private implementation detail');
    });
    app.use(internalErrorHandler);

    await withListeningApp(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/throws`, {
        headers: { origin: 'https://frontend.example' },
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'Internal Server Error' });
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://frontend.example');
    });

    assert.match(String(logged[0]?.[1]), /private implementation detail/);
  } finally {
    console.error = originalConsoleError;
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
  }
});
