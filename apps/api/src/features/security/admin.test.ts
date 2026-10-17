import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { adminActionOf } from '../../core/middleware/admin';
import { pinnedCatalogue } from './catalogue';
import { createSecuritySettingsAdminRouter } from './admin.routes';
import { parseSettingsChange } from './service';
import {
  DEFAULT_DISABLED_RULES,
  SecuritySettingsError,
  applyDataChanges,
  applyRuleChanges,
  defaultLeaseSettings,
  defaultRuleSettings,
  diffRuleSettings,
  enabledDataSettings,
  sameLeaseSettings,
  validateAgents,
  validateRuleSettings,
} from './settings';

const catalogue = pinnedCatalogue();

test('settings: the default policy is 44 of 51 on at upstream severity, data switches off, all five agents', () => {
  const rules = defaultRuleSettings(catalogue);
  assert.equal(Object.keys(rules).length, 51);
  assert.equal(Object.values(rules).filter(rule => rule.enabled).length, 44);
  for (const id of DEFAULT_DISABLED_RULES) assert.equal(rules[id].enabled, false, id);
  for (const rule of catalogue.manifest.rules) assert.equal(rules[rule.id].severity, rule.severity);
  const lease = defaultLeaseSettings();
  assert.deepEqual(enabledDataSettings(lease.data), []);
  assert.deepEqual(lease.agents, ['claude-code', 'codex', 'cursor', 'gemini-cli', 'copilot']);
  assert.equal(lease.dayOneScan, false);
  assert.deepEqual(validateRuleSettings(rules, catalogue), rules, 'the stored shape round-trips');
});

test('settings: changes are switches only and refuse anything else', () => {
  const rules = defaultRuleSettings(catalogue);
  const next = applyRuleChanges(rules, { 'secrets.agent_read_env': { enabled: true, severity: 'critical' } });
  assert.deepEqual(diffRuleSettings(rules, next).map(change => change.id), ['secrets.agent_read_env']);
  assert.deepEqual(diffRuleSettings(rules, applyRuleChanges(rules, undefined)), []);
  for (const bad of [
    { 'not.a.rule': { enabled: false } },
    { 'secrets.agent_read_env': {} },
    { 'secrets.agent_read_env': { enabled: 'yes' } },
    { 'secrets.agent_read_env': { severity: 'urgent' } },
    { 'secrets.agent_read_env': { enforce: true } },
    [],
  ]) assert.throws(() => applyRuleChanges(rules, bad), SecuritySettingsError);
  const data = applyDataChanges(defaultLeaseSettings().data, { urls: true });
  assert.deepEqual(enabledDataSettings(data), ['urls']);
  assert.throws(() => applyDataChanges(data, { tool_input: true }), SecuritySettingsError);
  assert.throws(() => applyDataChanges(data, { urls: 1 }), SecuritySettingsError);
  assert.deepEqual(validateAgents(['codex', 'claude-code']), ['claude-code', 'codex'], 'canonical order');
  for (const bad of [[], ['codex', 'codex'], ['opencode'], 'codex']) assert.throws(() => validateAgents(bad), SecuritySettingsError);
  const lease = defaultLeaseSettings();
  assert.equal(sameLeaseSettings(lease, { ...lease, data }), false);
  assert.equal(sameLeaseSettings(lease, defaultLeaseSettings()), true);
  const incomplete = { ...defaultRuleSettings(catalogue) };
  delete incomplete['secrets.agent_read_env'];
  assert.throws(() => validateRuleSettings(incomplete, catalogue), SecuritySettingsError);
});

test('settings change body: closed, dry_run and reason required', () => {
  assert.deepEqual(parseSettingsChange({ dry_run: true, reason: 'r', monitor_mode: 'monitor' }).change.monitorMode, 'monitor');
  for (const bad of [
    { reason: 'r' },
    { dry_run: true },
    { dry_run: true, reason: '' },
    { dry_run: true, reason: 'r', monitor_mode: 'monitor_and_pilot_block' },
    { dry_run: true, reason: 'r', tenant_id: '11111111-1111-4111-8111-111111111111' },
    { dry_run: true, reason: 'r', day_one_scan: 'yes' },
    null,
  ]) assert.throws(() => parseSettingsChange(bad), SecuritySettingsError);
});

async function serve(deps: Parameters<typeof createSecuritySettingsAdminRouter>[0]) {
  // No outer parser: the router's own express.json and error handler answer malformed JSON.
  const app = express();
  app.use('/api/admin/security', createSecuritySettingsAdminRouter({ log: () => undefined, ...deps }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/security/settings`;
  return { base, close: () => new Promise(resolve => server.close(resolve)) };
}

const refuse = (status: number): RequestHandler => (_req, res) => { res.status(status).json({ error: 'raw guard text' }); };

test('admin routes: guard refusals become problems; every response is no-store with a request id', async () => {
  const { base, close } = await serve({ authorizeRead: refuse(403), authorizeWrite: refuse(401) });
  try {
    const read = await fetch(base, { headers: { 'X-Request-ID': 'req-20f' } });
    assert.equal(read.status, 403);
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.equal(read.headers.get('x-request-id'), 'req-20f');
    assert.match(read.headers.get('content-type') ?? '', /application\/problem\+json/);
    const body = await read.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['code', 'request_id', 'status', 'title', 'type']);
    assert.equal(body.code, 'SECURITY_SETTINGS_FORBIDDEN');
    assert.ok(!JSON.stringify(body).includes('raw guard text'));
    const write = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json', 'X-Request-ID': 'bad id!' }, body: '{}' });
    assert.equal(write.status, 401);
    assert.match(write.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/, 'an invalid caller id is replaced');
    assert.equal((await write.json() as { code: string }).code, 'SECURITY_SETTINGS_UNAUTHENTICATED');
  } finally {
    await close();
  }
});

test('admin routes: an invalid body is refused before any database work', async () => {
  const pass: RequestHandler = (req, _res, next) => { req.tenantId = '11111111-1111-4111-8111-111111111111'; next(); };
  const { base, close } = await serve({ authorizeRead: pass, authorizeWrite: pass });
  try {
    for (const body of ['{"reason":"r"}', '{"dry_run":true,"reason":"r","machine_id":"x"}', '{not json']) {
      const response = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
      assert.equal(response.status, 400, body);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json() as { code: string }).code, 'SECURITY_SETTINGS_INVALID');
    }
  } finally {
    await close();
  }
});

test('admin routes: GET is guarded by security_findings.read, PUT by security.settings.manage', () => {
  const router = createSecuritySettingsAdminRouter();
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> }).stack;
  const guards = Object.fromEntries(stack.filter(layer => layer.route).map(layer => [
    `${Object.keys(layer.route!.methods)[0].toUpperCase()} ${layer.route!.path}`,
    layer.route!.stack.map(item => adminActionOf(item.handle)).find(Boolean),
  ]));
  assert.deepEqual(guards, { 'GET /settings': 'security_findings.read', 'PUT /settings': 'security.settings.manage' });
});
