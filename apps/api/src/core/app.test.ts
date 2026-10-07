import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Express, RequestHandler } from 'express';
import { createApp } from '../app';

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
