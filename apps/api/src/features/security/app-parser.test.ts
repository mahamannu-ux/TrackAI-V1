/**
 * Task20f D7 (Task20d decision 3): app.ts skips its global 5 MB JSON parser for
 * /worker/security/v2, so the v2 router authenticates the machine and applies its own
 * 4 MiB limit before any body byte is parsed. Every other route keeps the 5 MB parser.
 * Driven through the real createApp in-process; only machine authentication is a stub
 * that records whether the body was already parsed when it ran.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import { createApp } from '../../app';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MACHINE = '11111111-1111-4111-8111-111111111111';
const MIB = 1_048_576;

/** A JSON body of exactly `bytes` bytes. */
function jsonOf(bytes: number): Buffer {
  const head = '{"schema_version":"trackai.security-upload/2","records":[],"pad":"';
  return Buffer.from(head + 'x'.repeat(bytes - head.length - 2) + '"}');
}

async function withApp(authenticate: boolean, run: (base: string, parsedAtAuth: boolean[]) => Promise<void>): Promise<void> {
  const parsedAtAuth: boolean[] = [];
  const machineAuthentication: RequestHandler = (req, _res, next) => {
    // body-parser marks a request it has read with `_body`.
    parsedAtAuth.push((req as unknown as { _body?: boolean })._body === true);
    if (authenticate) {
      req.tenantId = TENANT;
      req.machineId = MACHINE;
      req.managedMachineCredential = true;
    }
    next();
  };
  const app = createApp({ machineAuthentication });
  const server = await new Promise<Server>(done => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, parsedAtAuth);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
  }
}

/** POST raw bytes; `chunked` omits Content-Length. Tolerates the server answering before the upload ends. */
function post(url: string, body: Buffer, chunked = false): Promise<{ status: number; body: string }> {
  return new Promise((resolvePost, reject) => {
    const req = httpRequest(url, {
      method: 'POST',
      headers: chunked ? { 'content-type': 'application/json' } : { 'content-type': 'application/json', 'content-length': body.length },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolvePost({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'EPIPE' || (error as NodeJS.ErrnoException).code === 'ECONNRESET') return;
      reject(error);
    });
    if (chunked) {
      for (let offset = 0; offset < body.length; offset += 256 * 1024) req.write(body.subarray(offset, offset + 256 * 1024));
      req.end();
    } else {
      req.end(body);
    }
  });
}

test('an unauthenticated 4.5 MiB security v2 body is refused 403 before it is parsed', async () => {
  await withApp(false, async (base, parsedAtAuth) => {
    const answer = await post(`${base}/worker/security/v2/records`, jsonOf(4.5 * MIB));
    assert.equal(answer.status, 403);
    assert.equal(JSON.parse(answer.body).code, 'SECURITY_V2_LEASE_REQUIRED');
    // Routing is case-insensitive, and so is the skip.
    const upper = await post(`${base}/WORKER/Security/V2/records`, jsonOf(4.5 * MIB));
    assert.equal(upper.status, 403);
    assert.deepEqual(parsedAtAuth, [false, false], 'machine authentication ran before any parser');
  });
});

test('an authenticated security v2 body over 4 MiB gets 413, with or without Content-Length; 4 MiB still parses', async () => {
  await withApp(true, async (base, parsedAtAuth) => {
    for (const chunked of [false, true]) {
      const answer = await post(`${base}/worker/security/v2/records`, jsonOf(4 * MIB + 1), chunked);
      assert.equal(answer.status, 413, `chunked=${chunked}`);
      assert.equal(JSON.parse(answer.body).code, 'SECURITY_V2_PAYLOAD_TOO_LARGE');
    }
    // Exactly 4 MiB passes the limit and reaches validation (the padded body is not a valid upload).
    const atLimit = await post(`${base}/worker/security/v2/records`, jsonOf(4 * MIB));
    assert.equal(atLimit.status, 400);
    assert.equal(JSON.parse(atLimit.body).code, 'SECURITY_V2_UNKNOWN_FIELD');
    assert.deepEqual(parsedAtAuth, [false, false, false]);
  });
});

test('other worker routes keep the global 5 MB parser', async () => {
  await withApp(false, async (base, parsedAtAuth) => {
    await post(`${base}/worker/fleet/report`, jsonOf(4.5 * MIB));
    await post(`${base}/worker/security/findings`, jsonOf(4.5 * MIB));
    await post(`${base}/worker/security/v2x`, jsonOf(1_000));
    assert.deepEqual(parsedAtAuth, [true, true, true], 'parsed before machine authentication, as before');
    const quiet = console.error;
    console.error = () => undefined; // the app's internal handler logs the parser's 413
    const tooLarge = await post(`${base}/worker/fleet/report`, jsonOf(5 * MIB + 1)).finally(() => { console.error = quiet; });
    assert.notEqual(tooLarge.status, 200);
    assert.equal(parsedAtAuth.length, 3, 'a body over 5 MB never reaches authentication');
  });
});
