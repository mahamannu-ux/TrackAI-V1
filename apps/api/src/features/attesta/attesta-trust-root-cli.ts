/**
 * Offline root tool (Task15l, A15.12): builds and signs the platform root document
 * on a machine with no database and no network (trust.md "Hierarchy").
 *
 *   npm run attesta:trust-root -w apps/api -- keyid --key <pem>
 *   npm run attesta:trust-root -w apps/api -- draft --root-pub <pem>... --online <purpose>=<pem>...
 *        [--threshold k] [--previous <signed root.json>] [--issued-at <iso>] [--expires-days 365] --out <draft.json>
 *   npm run attesta:trust-root -w apps/api -- sign --draft <draft.json> --key <root pem>... [--previous <signed root.json>] --out <root.json>
 *
 * `draft` writes the unsigned body (public keys only); `sign` signs it with every
 * root key file given, checks the result the way verifiers will (k of its own root
 * keys and, after version 1, k of the previous root's), and writes the envelope.
 * It prints keyids and the document digest only, never key material. Private keys
 * are read from PEM files and never written. Refuses to run when DATABASE_URL is
 * set: the root ceremony belongs on an offline machine (A15.13, founder-live).
 *
 * Port from: none (SushiCorp has no offline root; its trust lists are X.509 anchors).
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  PLATFORM_ONLINE_PURPOSES,
  TRUST_ROOT_TYPE,
  type KeyPurpose,
  type TrustDocumentBody,
  type TrustKeyEntry,
} from './trust-contract';
import {
  forwardOnlyViolation,
  keyidOf,
  parseTimestamp,
  parseTrustDocument,
  signTrustDocument,
  trustDocumentPayload,
  validDocumentSigners,
  type ParsedDocument,
  type ParsedKey,
} from './trust-documents';

export interface CliIo {
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
  now(): Date;
}

export class CliError extends Error {}

function parseArgs(argv: string[]): { command: string; opts: Map<string, string[]> } {
  const [command, ...rest] = argv;
  const opts = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new CliError(`unexpected argument ${JSON.stringify(a)}`);
    const eq = a.indexOf('=');
    const [name, value] = eq > 0 ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), rest[++i]];
    if (value === undefined) throw new CliError(`--${name} needs a value`);
    opts.set(name, [...(opts.get(name) ?? []), value]);
  }
  return { command: command ?? '', opts };
}

function one(opts: Map<string, string[]>, name: string, required = true): string | undefined {
  const v = opts.get(name);
  if (!v || v.length === 0) {
    if (required) throw new CliError(`--${name} is required`);
    return undefined;
  }
  if (v.length > 1) throw new CliError(`--${name} given twice`);
  return v[0];
}

function checkP256(key: KeyObject, label: string): void {
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new CliError(`${label} is not an ECDSA P-256 key`);
  }
}

/** SPKI DER from a PEM that holds a public or a private key. Never prints it. */
function spkiFromPem(io: CliIo, path: string, label: string): Buffer {
  let text: string;
  try {
    text = io.readFile(path);
  } catch {
    throw new CliError(`${label}: file cannot be read`);
  }
  let pub: KeyObject;
  try {
    pub = /PRIVATE KEY/.test(text) ? createPublicKey(createPrivateKey(text)) : createPublicKey(text);
  } catch {
    throw new CliError(`${label}: not a PEM key`);
  }
  checkP256(pub, label);
  return pub.export({ type: 'spki', format: 'der' }) as Buffer;
}

function privateFromPem(io: CliIo, path: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(io.readFile(path));
  } catch {
    throw new CliError('--key: not a readable PEM private key');
  }
  checkP256(key, '--key');
  return key;
}

function readSignedRoot(io: CliIo, path: string): ParsedDocument {
  let doc: ParsedDocument;
  try {
    doc = parseTrustDocument(JSON.parse(io.readFile(path)));
  } catch {
    throw new CliError('--previous: not a valid signed root document');
  }
  if (doc.kind !== 'root') throw new CliError('--previous: not a root document');
  // The predecessor must carry its own root threshold of valid signatures (a
  // tampered or under-signed file is refused before anything builds on it).
  if (validDocumentSigners(doc, activeRoots(doc), 'root').size < (doc.body.threshold as number)) {
    throw new CliError('--previous: its root signatures do not meet its own threshold (tampered or incomplete)');
  }
  return doc;
}

function activeRoots(doc: ParsedDocument): Map<string, ParsedKey> {
  return new Map([...doc.keys].filter(([, k]) => k.entry.purpose === 'root' && k.entry.status === 'active'));
}

function iso(d: Date): string {
  return d.toISOString();
}

function draft(io: CliIo, opts: Map<string, string[]>): void {
  const issued = one(opts, 'issued-at', false) ?? iso(io.now());
  if (parseTimestamp(issued) === null) throw new CliError('--issued-at must be RFC 3339 UTC with milliseconds');
  const days = Number(one(opts, 'expires-days', false) ?? '365');
  if (!Number.isInteger(days) || days < 1 || days > 3660) throw new CliError('--expires-days must be 1..3660');
  const expires = iso(new Date(Date.parse(issued) + days * 86_400_000));
  const prev = opts.has('previous') ? readSignedRoot(io, one(opts, 'previous') as string) : null;
  const keys: TrustKeyEntry[] = [];
  const seen = new Set<string>();
  const add = (spki: Buffer, purpose: KeyPurpose) => {
    const keyid = keyidOf(spki);
    if (seen.has(keyid)) throw new CliError(`a key is listed twice (${keyid})`);
    seen.add(keyid);
    const kept = prev?.keys.get(keyid)?.entry;
    if (purpose === 'root') {
      // Root keys are not forward-only: renew their validity with each root document
      // (verifiers require it to cover the next document's issued_at).
      keys.push({ keyid, purpose, spki_der_b64: spki.toString('base64'), not_before: kept?.purpose === 'root' ? kept.not_before : issued, not_after: expires, status: 'active' });
    } else if (kept && kept.purpose === purpose) {
      keys.push(kept); // an existing online key stays exactly as it was (forward-only)
    } else {
      keys.push({ keyid, purpose, spki_der_b64: spki.toString('base64'), not_before: issued, not_after: expires, status: 'active' });
    }
  };
  for (const p of opts.get('root-pub') ?? []) add(spkiFromPem(io, p, '--root-pub'), 'root');
  for (const spec of opts.get('online') ?? []) {
    const eq = spec.indexOf('=');
    const purpose = spec.slice(0, eq) as KeyPurpose;
    if (eq < 1 || !(PLATFORM_ONLINE_PURPOSES as readonly string[]).includes(purpose)) {
      throw new CliError(`--online must be <purpose>=<pem> with purpose one of ${PLATFORM_ONLINE_PURPOSES.join(', ')}`);
    }
    add(spkiFromPem(io, spec.slice(eq + 1), `--online ${purpose}`), purpose);
  }
  // Non-root keys of the previous root that were not given again stay, as they were
  // (a later document never drops a platform key; retire or revoke them in 15l2's CLI).
  if (prev) {
    for (const [keyid, k] of prev.keys) {
      if (k.entry.purpose !== 'root' && !seen.has(keyid)) {
        keys.push(k.entry);
        seen.add(keyid);
      }
    }
  }
  const body: TrustDocumentBody = {
    _type: TRUST_ROOT_TYPE, scope: 'platform', version: prev ? prev.body.version + 1 : 1, issued_at: issued, expires,
    previous: prev ? prev.digest : null, threshold: Number(one(opts, 'threshold', false) ?? '1'), keys,
  };
  try {
    trustDocumentPayload(body);
  } catch (err) {
    throw new CliError(`draft is not a valid root document: ${(err as Error).message}`);
  }
  io.writeFile(one(opts, 'out') as string, JSON.stringify(body, null, 2) + '\n');
  io.out(`draft root version ${body.version}, threshold ${body.threshold}, ${keys.length} keys`);
  for (const k of keys) io.out(`  ${k.purpose.padEnd(16)} ${k.keyid} ${k.status}`);
}

async function signCmd(io: CliIo, opts: Map<string, string[]>): Promise<void> {
  let body: TrustDocumentBody;
  try {
    body = JSON.parse(io.readFile(one(opts, 'draft') as string)) as TrustDocumentBody;
    trustDocumentPayload(body);
  } catch {
    throw new CliError('--draft: not a valid unsigned root document');
  }
  if (body._type !== TRUST_ROOT_TYPE) throw new CliError('--draft: not a root document');
  const keyFiles = opts.get('key') ?? [];
  if (keyFiles.length === 0) throw new CliError('--key is required (one per root key that signs)');
  const signers = keyFiles.map((path) => {
    const key = privateFromPem(io, path);
    const keyid = keyidOf(createPublicKey(key).export({ type: 'spki', format: 'der' }) as Buffer);
    return { keyid, sign: (b: Buffer) => cryptoSign('sha256', b, { key, dsaEncoding: 'der' }) };
  });
  if (new Set(signers.map((s) => s.keyid)).size !== signers.length) throw new CliError('--key: the same key given twice');
  const env = await signTrustDocument(body, signers);
  const doc = parseTrustDocument(env);
  const own = validDocumentSigners(doc, activeRoots(doc), 'root');
  if (own.size < (body.threshold as number)) {
    throw new CliError(`only ${own.size} of the document's own root keys signed; threshold is ${body.threshold}`);
  }
  if (body.version > 1) {
    const prevPath = one(opts, 'previous', false);
    if (!prevPath) throw new CliError('--previous is required after version 1 (the chain is checked before writing)');
    const prev = readSignedRoot(io, prevPath);
    if (prev.body.version + 1 !== body.version || prev.digest !== body.previous) throw new CliError('--previous is not the version before this draft');
    // The same transition rules the verifier applies: forward-only platform keys,
    // issued_at never going back.
    if (forwardOnlyViolation(prev, doc)) {
      throw new CliError('the draft drops, widens or un-revokes a platform key, or moves issued_at back (forward-only rule)');
    }
    const old = validDocumentSigners(doc, activeRoots(prev), 'root');
    if (old.size < (prev.body.threshold as number)) {
      throw new CliError(`only ${old.size} of the previous root's keys signed; its threshold is ${prev.body.threshold}`);
    }
  }
  io.writeFile(one(opts, 'out') as string, JSON.stringify(env, null, 2) + '\n');
  io.out(`signed root version ${body.version}: digest ${doc.digest}`);
  for (const s of signers) io.out(`  signed by ${s.keyid}`);
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  try {
    if (io.env.DATABASE_URL) throw new CliError('DATABASE_URL is set: run the root tool on an offline machine with no database');
    const { command, opts } = parseArgs(argv);
    if (command === 'keyid') {
      io.out(keyidOf(spkiFromPem(io, one(opts, 'key') as string, '--key')));
    } else if (command === 'draft') {
      draft(io, opts);
    } else if (command === 'sign') {
      await signCmd(io, opts);
    } else {
      throw new CliError('usage: attesta:trust-root <keyid|draft|sign> … (see the file header)');
    }
    return 0;
  } catch (err) {
    io.err(err instanceof CliError ? err.message : 'failed (no details printed: they could contain key material)');
    return 1;
  }
}

if (require.main === module) {
  const io: CliIo = {
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, t) => writeFileSync(p, t, { flag: 'wx', mode: 0o644 }),
    out: (l) => process.stdout.write(l + '\n'),
    err: (l) => process.stderr.write(l + '\n'),
    env: process.env,
    now: () => new Date(),
  };
  void main(process.argv.slice(2), io).then((code) => {
    process.exitCode = code;
  });
}
