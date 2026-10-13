/**
 * Online trust-inventory CLI (Task15l2, A15.12; trust.md "Rotation and revocation
 * procedures"):
 *
 *   npm run attesta:keys -w apps/api -- register --adapter <name> --credential <ref> (--tenant <uuid> | --purpose <platform purpose>) [--valid-days 365]
 *   npm run attesta:keys -w apps/api -- activate --tenant <uuid> --keyid <sha256:…> [--replace]
 *   npm run attesta:keys -w apps/api -- retire   --tenant <uuid> --keyid <sha256:…>
 *   npm run attesta:keys -w apps/api -- revoke   --tenant <uuid> --keyid <sha256:…> --reason superseded|compromised [--compromised-since <iso>]
 *   npm run attesta:keys -w apps/api -- publish  (--tenant <uuid> | --all-tenants)
 *   npm run attesta:keys -w apps/api -- export-root-draft --out <draft.json> [--previous-out <root.json>]
 *        [--retire <keyid>]… [--revoke <keyid>… --reason … [--compromised-since <iso>]] [--root-pub <pem>… --threshold k]
 *   npm run attesta:keys -w apps/api -- import-root --file <signed root.json>
 *   npm run attesta:keys -w apps/api -- list [--tenant <uuid>]
 *
 * Every changing command is a **dry run by default**: it prints its exact scope
 * (tenant, keyids, new statuses, document version) and the flags that apply it,
 * `--confirm=<COMMAND> --expect=<n> --actor <name>`. Applied runs write their
 * attesta_key_events rows and, for tenant-scoped actions, one security_audit_events
 * row (`attesta.keys.<command>`); platform actions are audited in attesta_key_events.
 * Platform keys never change here except through `import-root` of a root document
 * signed offline (`attesta:trust-root sign`). Output names keyids, purposes,
 * statuses and validity only: never credential references or key material. Refuses
 * to run with a development signer in production.
 *
 * Environment: DATABASE_URL, ATTESTA_TRUST_ROOT_KEYIDS (required in production),
 * ATTESTA_KMS_CREDENTIALS_FILE, ATTESTA_DEV_CREDENTIALS_FILE (development only).
 *
 * Port from: SushiCorp A1b `python -m adapters.signing.inventory sync|check-expiry`
 * @ 0bd67a5 (catalog SG-1: operator CLI over the public inventory). New: dry-run
 * with exact scope and --confirm/--expect (AGENTS.md §9 item 10), documents.
 */
import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isProduction } from './anchor-contract';
import { SigningError } from './signer-contract';
import { LOCAL_DEV_ADAPTER_NAME } from './signer-local-dev';
import { PLATFORM_ONLINE_PURPOSES, type KeyPurpose } from './trust-contract';
import { DIGEST_RE, parseTimestamp } from './trust-documents';
import {
  PlatformSignerError,
  TrustInventoryError,
  applyTenantKeyCommand,
  exportRootDraft,
  importRoot,
  listKeys,
  pgTrustStore,
  planPublish,
  planRegistration,
  planRootImport,
  planTenantKeyCommand,
  publishKeyset,
  registerKey,
  type InventoryContext,
  type Plan,
  type TrustAdapters,
  type TrustDb,
  type TrustStore,
} from './trust-inventory';
import { TrustConfigError, adaptersFromEnv, trustConfigFromEnv } from './trust-resolver';

export interface KeysCliIo {
  readFile(path: string): string;
  /** Must refuse to overwrite an existing file. */
  writeFile(path: string, text: string): void;
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
  now(): Date;
  /** Test seams; the real CLI opens DATABASE_URL and builds adapters from the environment. */
  store?: TrustStore;
  adapters?: TrustAdapters;
}

export class KeysCliError extends Error {}

const CHANGING = ['register', 'activate', 'retire', 'revoke', 'publish', 'import-root'] as const;
type Changing = (typeof CHANGING)[number];
const VALUE_FREE = new Set(['replace', 'all-tenants']);

function parseArgs(argv: string[]): { command: string; opts: Map<string, string[]> } {
  const [command, ...rest] = argv;
  const opts = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new KeysCliError(`unexpected argument ${JSON.stringify(a)}`);
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let value: string | undefined;
    if (eq > 0) value = a.slice(eq + 1);
    else if (VALUE_FREE.has(name)) value = 'true';
    else value = rest[++i];
    if (value === undefined) throw new KeysCliError(`--${name} needs a value`);
    opts.set(name, [...(opts.get(name) ?? []), value]);
  }
  return { command: command ?? '', opts };
}

function one(opts: Map<string, string[]>, name: string, required = true): string | undefined {
  const v = opts.get(name);
  if (!v || v.length === 0) {
    if (required) throw new KeysCliError(`--${name} is required`);
    return undefined;
  }
  if (v.length > 1) throw new KeysCliError(`--${name} given twice`);
  return v[0];
}

const ALLOWED: Record<string, string[]> = {
  register: ['adapter', 'credential', 'tenant', 'purpose', 'valid-days'],
  activate: ['tenant', 'keyid', 'replace'],
  retire: ['tenant', 'keyid'],
  revoke: ['tenant', 'keyid', 'reason', 'compromised-since'],
  publish: ['tenant', 'all-tenants'],
  'export-root-draft': ['out', 'previous-out', 'retire', 'revoke', 'reason', 'compromised-since', 'root-pub', 'threshold'],
  'import-root': ['file'],
  list: ['tenant'],
};

function checkOptions(command: string, opts: Map<string, string[]>): void {
  const allowed = new Set([...(ALLOWED[command] ?? []), ...((CHANGING as readonly string[]).includes(command) ? ['confirm', 'expect', 'actor'] : [])]);
  for (const name of opts.keys()) if (!allowed.has(name)) throw new KeysCliError(`--${name} does not apply to ${command}`);
}

function keyidArg(opts: Map<string, string[]>): string {
  const keyid = one(opts, 'keyid') as string;
  if (!DIGEST_RE.test(keyid)) throw new KeysCliError('--keyid must be sha256:<64 hex>');
  return keyid;
}

function isoArg(opts: Map<string, string[]>, name: string): string | undefined {
  const v = one(opts, name, false);
  if (v !== undefined && parseTimestamp(v) === null) throw new KeysCliError(`--${name} must be RFC 3339 UTC with milliseconds (2026-10-13T10:00:00.000Z)`);
  return v;
}

/** `null` = dry run; otherwise the confirmed --expect. */
function confirmation(command: Changing, opts: Map<string, string[]>): { expect: number; actor: string } | null {
  const confirm = one(opts, 'confirm', false);
  const expect = one(opts, 'expect', false);
  if (confirm === undefined) {
    if (expect !== undefined) throw new KeysCliError('--expect needs --confirm');
    return null;
  }
  if (confirm !== command.toUpperCase()) throw new KeysCliError(`--confirm must be exactly ${command.toUpperCase()}`);
  if (expect === undefined || !/^[0-9]{1,9}$/.test(expect)) throw new KeysCliError(`--confirm=${command.toUpperCase()} needs --expect=<the dry-run count>`);
  const actor = one(opts, 'actor', false);
  if (!actor || actor.length > 128 || !/^[A-Za-z0-9._@:+-]+$/.test(actor)) throw new KeysCliError('--actor <your name> is required to apply (1..128 of A-Za-z0-9._@:+-)');
  return { expect: Number(expect), actor };
}

function printPlan(io: KeysCliIo, plan: Plan, applied: boolean): void {
  io.out(applied ? `APPLIED ${plan.command}` : `DRY RUN ${plan.command} (nothing changed)`);
  for (const l of plan.lines) io.out(`  ${l}`);
  if (!applied) io.out(`apply with: --confirm=${plan.command.toUpperCase()} --expect=${plan.expect} --actor <your name>`);
}

function spkiFromPem(io: KeysCliIo, path: string): Buffer {
  let text: string;
  try {
    text = io.readFile(path);
  } catch {
    throw new KeysCliError('--root-pub: file cannot be read');
  }
  let pub: KeyObject;
  try {
    pub = /PRIVATE KEY/.test(text) ? createPublicKey(createPrivateKey(text)) : createPublicKey(text);
  } catch {
    throw new KeysCliError('--root-pub: not a PEM key');
  }
  return pub.export({ type: 'spki', format: 'der' }) as Buffer;
}

async function run(io: KeysCliIo, command: string, opts: Map<string, string[]>, ctx: InventoryContext): Promise<number> {
  const tenant = one(opts, 'tenant', false);
  switch (command) {
    case 'list': {
      for (const line of await listKeys(ctx.store, tenant ?? null)) io.out(line);
      return 0;
    }
    case 'register': {
      const ok = confirmation('register', opts);
      const purpose = (tenant ? 'statement' : one(opts, 'purpose')) as KeyPurpose;
      if (tenant && opts.has('purpose') && one(opts, 'purpose') !== 'statement') throw new KeysCliError('--purpose: tenant keys are statement keys');
      const validDays = one(opts, 'valid-days', false);
      const input = { tenantId: tenant ?? null, purpose, adapterName: one(opts, 'adapter') as string,
        credentialRef: one(opts, 'credential') as string, validDays: validDays === undefined ? undefined : Number(validDays) };
      const plan = await planRegistration(ctx, input);
      if (!ok) return printPlan(io, plan, false), 0;
      if (ok.expect !== plan.expect) throw new KeysCliError(`--expect=${ok.expect} but register changes ${plan.expect} key`);
      const key = await registerKey({ ...ctx, actor: ok.actor }, input);
      printPlan(io, { ...plan, lines: [...plan.lines, `stored ${key.keyid} as registered (proof of possession verified)`] }, true);
      return 0;
    }
    case 'activate':
    case 'retire':
    case 'revoke': {
      const ok = confirmation(command, opts);
      const reason = one(opts, 'reason', false);
      if (reason !== undefined && reason !== 'superseded' && reason !== 'compromised') throw new KeysCliError('--reason must be superseded or compromised');
      const cmd = { tenantId: one(opts, 'tenant') as string, keyid: keyidArg(opts), replace: opts.has('replace'),
        reason: reason as 'superseded' | 'compromised' | undefined, compromisedSince: isoArg(opts, 'compromised-since') };
      if (!ok) return printPlan(io, await planTenantKeyCommand(ctx, command, cmd), false), 0;
      printPlan(io, await applyTenantKeyCommand({ ...ctx, actor: ok.actor }, command, cmd, ok.expect), true);
      return 0;
    }
    case 'publish': {
      const ok = confirmation('publish', opts);
      const all = opts.has('all-tenants');
      if (all === Boolean(tenant)) throw new KeysCliError('publish needs exactly one of --tenant <uuid> or --all-tenants');
      const tenants = all ? await ctx.store.tenantsWithPublishableKeys() : [tenant as string];
      const planned: string[] = [];
      const lines: string[] = [];
      let failures = 0;
      for (const t of tenants) {
        try {
          const p = await planPublish(ctx, t);
          planned.push(t);
          lines.push(...p.lines);
        } catch (err) {
          if (!all) throw err;
          failures += 1;
          lines.push(`tenant ${t}: refused (${err instanceof TrustInventoryError ? err.code : 'error'}): ${safeMessage(err)}`);
        }
      }
      const plan: Plan = { command: 'publish', expect: planned.length, lines };
      if (!ok) return printPlan(io, plan, false), failures > 0 ? 1 : 0;
      if (ok.expect !== planned.length) throw new KeysCliError(`--expect=${ok.expect} but ${planned.length} tenants would be published; run the dry run again`);
      const done: string[] = [];
      for (const t of planned) {
        try {
          done.push(...(await publishKeyset({ ...ctx, actor: ok.actor }, t)).lines);
        } catch (err) {
          failures += 1;
          done.push(`tenant ${t}: refused (${err instanceof TrustInventoryError ? err.code : 'error'}): ${safeMessage(err)}`);
        }
      }
      printPlan(io, { ...plan, lines: done }, true);
      return failures > 0 ? 1 : 0;
    }
    case 'export-root-draft': {
      const out = one(opts, 'out') as string;
      const threshold = one(opts, 'threshold', false);
      const reason = one(opts, 'reason', false);
      if (reason !== undefined && reason !== 'superseded' && reason !== 'compromised') throw new KeysCliError('--reason must be superseded or compromised');
      for (const k of [...(opts.get('retire') ?? []), ...(opts.get('revoke') ?? [])]) {
        if (!DIGEST_RE.test(k)) throw new KeysCliError('--retire / --revoke take sha256:<64 hex> keyids');
      }
      const draft = await exportRootDraft(ctx, {
        retire: opts.get('retire'), revoke: opts.get('revoke'), reason: reason as 'superseded' | 'compromised' | undefined,
        compromisedSince: isoArg(opts, 'compromised-since'),
        rootSpkis: (opts.get('root-pub') ?? []).map((p) => spkiFromPem(io, p)),
        threshold: threshold === undefined ? undefined : Number(threshold),
      });
      const previousOut = one(opts, 'previous-out', false);
      if (draft.previous && !previousOut) throw new KeysCliError('--previous-out <path> is required after version 1 (the offline sign needs the current root)');
      io.writeFile(out, JSON.stringify(draft.body, null, 2) + '\n');
      if (draft.previous && previousOut) io.writeFile(previousOut, JSON.stringify(draft.previous, null, 2) + '\n');
      for (const l of draft.lines) io.out(l);
      io.out(`next: on the offline machine, attesta:trust-root sign --draft <draft> --key <root pem>…${draft.previous ? ' --previous <previous-out>' : ''} --out <root.json>; then import-root --file <root.json>`);
      return 0;
    }
    case 'import-root': {
      const ok = confirmation('import-root', opts);
      let envelope: unknown;
      try {
        envelope = JSON.parse(io.readFile(one(opts, 'file') as string));
      } catch {
        throw new KeysCliError('--file: not a readable JSON document');
      }
      if (!ok) return printPlan(io, await planRootImport(ctx, envelope), false), 0;
      printPlan(io, await importRoot({ ...ctx, actor: ok.actor }, envelope, ok.expect), true);
      return 0;
    }
    default:
      throw new KeysCliError('usage: attesta:keys <register|activate|retire|revoke|publish|export-root-draft|import-root|list> … (see the file header)');
  }
}

/** Messages of our own error classes are written to name variables and keyids only. */
function safeMessage(err: unknown): string {
  if (err instanceof KeysCliError || err instanceof TrustInventoryError || err instanceof TrustConfigError ||
      err instanceof PlatformSignerError) return err.message;
  // Signer messages can quote the credential reference: print the class only.
  if (err instanceof SigningError) return `signer ${err.name} (details withheld: they could name a credential)`;
  return 'failed (details withheld: they could name a credential)';
}

export async function main(argv: string[], io: KeysCliIo): Promise<number> {
  try {
    const { command, opts } = parseArgs(argv);
    if (!ALLOWED[command]) throw new KeysCliError('usage: attesta:keys <register|activate|retire|revoke|publish|export-root-draft|import-root|list> … (see the file header)');
    checkOptions(command, opts);
    const config = trustConfigFromEnv(io.env);
    const adapters = io.adapters ?? await adaptersFromEnv(io.env);
    if (isProduction(io.env) && Object.prototype.hasOwnProperty.call(adapters, LOCAL_DEV_ADAPTER_NAME)) {
      throw new KeysCliError('a development signer is configured in production: refusing to run');
    }
    const store = io.store ?? pgTrustStore((await import('../../core/db')).db as unknown as TrustDb);
    const ctx: InventoryContext = { store, adapters, config, actor: 'dry-run', requestId: `attesta-keys:${randomUUID()}`, now: () => io.now() };
    return await run(io, command, opts, ctx);
  } catch (err) {
    const code = err instanceof TrustInventoryError ? ` [${err.code}]` : '';
    io.err(`refused${code}: ${safeMessage(err)}`);
    return 1;
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv/config');
  const io: KeysCliIo = {
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, t) => writeFileSync(p, t, { flag: 'wx', mode: 0o644 }),
    out: (l) => process.stdout.write(l + '\n'),
    err: (l) => process.stderr.write(l + '\n'),
    env: process.env,
    now: () => new Date(),
  };
  void main(process.argv.slice(2), io).then(async (code) => {
    process.exitCode = code;
    if (!io.store) {
      try {
        await (await import('../../core/db')).pool.end();
      } catch {
        // the pool was never opened
      }
    }
  });
}
