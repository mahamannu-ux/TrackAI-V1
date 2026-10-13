/**
 * `npm run attesta:verify-pack -w apps/api -- --pack <download.json>
 *   (--root-keyid sha256:… … | --customer-pin <file>)
 *   [--rekor-log-key <pem>] [--tsa-anchors <pem>] [--state <file>] [--json]`
 *
 * Offline evidence-pack check (Task15j, A15.10): counsel runs this on a laptop with no
 * TrackAI account and no network. It reads the files, calls the pure
 * `verifyEvidencePack`, prints a short human summary (one line per check) or the JSON
 * report, and exits with the report's exit code (0 genuine and complete, 1 broken,
 * 2 not checkable). An unreadable or invalid file is exit 2 with a clear message, never
 * a stack trace. Only codes, seqs and counts are printed: never statement contents and
 * never key material. There is no flag for `allowUnpinnedRoot` or `production: false`.
 *
 * Ported from SushiCorp services/anchoring/offline_verify.py @ 0bd67a5 (catalog EV-2)
 * - Node instead of Python;
 * - the trust documents travel in the pack, but the pin is the user's;
 * - DSSE and in-toto instead of JCS records;
 * - two pack modes.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyEvidencePack, type OfflineReport } from './offline-verifier';
import type { CustomerPinnedKey, TrustedDocumentRef } from './trust-contract';
import { loadLogPublicKey } from './anchor-rekor';
import { loadTrustAnchors } from './anchor-tsa';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Injectable side effects (tests hand in memory files). */
export interface VerifyPackIo {
  readFile: (path: string) => string;
  writeFile: (path: string, text: string) => void;
  renameFile: (tmp: string, dest: string) => void;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
}

const defaultIo = (): VerifyPackIo => ({
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, t) => writeFileSync(p, t, 'utf8'),
  renameFile: (t, d) => renameSync(t, d),
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  now: () => new Date(),
});

interface ParsedArgs {
  pack?: string;
  rootKeyids: string[];
  customerPin?: string;
  rekorLogKey?: string;
  tsaAnchors?: string;
  state?: string;
  json: boolean;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { rootKeyids: [], json: false };
  const take = (name: string, i: number): string => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`--${name} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const inline = eq > 0 ? arg.slice(eq + 1) : null;
    const value = (n: string): string => inline ?? take(n, i++);
    switch (name) {
      case 'pack': {
        if (out.pack !== undefined) throw new Error('--pack given twice');
        out.pack = value('pack');
        break;
      }
      case 'root-keyid': {
        out.rootKeyids.push(value('root-keyid'));
        break;
      }
      case 'customer-pin': {
        if (out.customerPin !== undefined) throw new Error('--customer-pin given twice');
        out.customerPin = value('customer-pin');
        break;
      }
      case 'rekor-log-key': {
        if (out.rekorLogKey !== undefined) throw new Error('--rekor-log-key given twice');
        out.rekorLogKey = value('rekor-log-key');
        break;
      }
      case 'tsa-anchors': {
        if (out.tsaAnchors !== undefined) throw new Error('--tsa-anchors given twice');
        out.tsaAnchors = value('tsa-anchors');
        break;
      }
      case 'state': {
        if (out.state !== undefined) throw new Error('--state given twice');
        out.state = value('state');
        break;
      }
      case 'json': {
        if (inline !== null) throw new Error('--json takes no value');
        out.json = true;
        break;
      }
      default:
        throw new Error(`unknown option --${name}`);
    }
  }
  return out;
}

function readJsonFile(io: VerifyPackIo, path: string, what: string): unknown {
  let text: string;
  try {
    text = io.readFile(path);
  } catch {
    throw new Error(`${what} ${JSON.stringify(path)} cannot be read`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${what} ${JSON.stringify(path)} is not valid JSON`);
  }
}

interface StateFile {
  lastTrusted: Record<string, TrustedDocumentRef>;
  trustedTimeFloor?: string;
}

function readStateFile(io: VerifyPackIo, path: string): StateFile {
  let text: string;
  try {
    text = io.readFile(path);
  } catch (err) {
    // First use has no state file yet: start from the empty state (trust.md
    // "First-use limit"). Anything else unreadable is exit 2.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { lastTrusted: {} };
    throw new Error(`state file ${JSON.stringify(path)} cannot be read`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`state file ${JSON.stringify(path)} is not valid JSON`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`state file ${JSON.stringify(path)} must be an object with lastTrusted`);
  }
  const { lastTrusted, trustedTimeFloor } = raw as Record<string, unknown>;
  if (typeof lastTrusted !== 'object' || lastTrusted === null || Array.isArray(lastTrusted)) {
    throw new Error(`state file ${JSON.stringify(path)} must be an object with lastTrusted`);
  }
  for (const [scope, ref] of Object.entries(lastTrusted as Record<string, unknown>)) {
    if (typeof ref !== 'object' || ref === null || Array.isArray(ref)
      || typeof (ref as Record<string, unknown>).version !== 'number'
      || typeof (ref as Record<string, unknown>).digest !== 'string') {
      throw new Error(`state file ${JSON.stringify(path)} has a bad lastTrusted entry for ${JSON.stringify(scope)}`);
    }
  }
  if (trustedTimeFloor !== undefined && typeof trustedTimeFloor !== 'string') {
    throw new Error(`state file ${JSON.stringify(path)} has a bad trustedTimeFloor`);
  }
  return {
    lastTrusted: lastTrusted as Record<string, TrustedDocumentRef>,
    ...(trustedTimeFloor !== undefined ? { trustedTimeFloor: trustedTimeFloor as string } : {}),
  };
}

function printHuman(io: VerifyPackIo, report: OfflineReport): void {
  io.out(`attesta evidence pack ${report.pack_id || '(unknown pack)'} tenant ${report.tenant_id || '(unknown tenant)'} generated ${report.generated_at || '(unknown time)'}`);
  for (const check of report.checks) {
    const extra = check.code !== undefined ? ` code=${check.code}` : '';
    const count = check.count !== undefined ? ` count=${check.count}` : '';
    io.out(`${check.id}: ${check.status}${extra}${count}`);
  }
  io.out(`counts: records=${report.counts.records} statements=${report.counts.statements} anchors_verified=${report.counts.anchors_verified}`);
  const trust = report.checks.find((c) => c.id === 'trust_and_signature');
  if (trust !== undefined && trust.status === 'not_checkable' && trust.code === 'ATTESTA_TRUST_DOCUMENT_EXPIRED') {
    io.out('note: a key document expired at check time. A pack is checked when it is handed over; ask for a fresh export.');
  }
  io.out(`result: ${report.result} (exit ${report.exit_code})`);
}

/** Run the command; returns the process exit code (never throws key material or a stack). */
export async function main(argv: string[], io: VerifyPackIo = defaultIo()): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    io.err(`attesta:verify-pack: ${err instanceof Error ? err.message : 'bad arguments'}`);
    return 2;
  }
  if (args.pack === undefined) {
    io.err('attesta:verify-pack: --pack <download.json> is required');
    return 2;
  }
  if (args.rootKeyids.length === 0 && args.customerPin === undefined) {
    io.err('attesta:verify-pack: give --root-keyid sha256:… (repeatable) or --customer-pin <file>');
    return 2;
  }
  if (args.rootKeyids.length > 0 && args.customerPin !== undefined) {
    io.err('attesta:verify-pack: --root-keyid and --customer-pin cannot be combined');
    return 2;
  }
  for (const keyid of args.rootKeyids) {
    if (!DIGEST_RE.test(keyid)) {
      io.err('attesta:verify-pack: --root-keyid must be sha256:<64 hex>');
      return 2;
    }
  }
  let download: unknown;
  try {
    download = readJsonFile(io, args.pack, 'pack file');
  } catch (err) {
    io.err(`attesta:verify-pack: ${err instanceof Error ? err.message : 'the pack file cannot be read'}`);
    return 2;
  }
  let customerPins: readonly CustomerPinnedKey[] | undefined;
  if (args.customerPin !== undefined) {
    let raw: unknown;
    try {
      raw = readJsonFile(io, args.customerPin, 'customer pin file');
    } catch (err) {
      io.err(`attesta:verify-pack: ${err instanceof Error ? err.message : 'the customer pin file cannot be read'}`);
      return 2;
    }
    if (!Array.isArray(raw)) {
      io.err('attesta:verify-pack: the customer pin file must be a JSON array of key entries');
      return 2;
    }
    customerPins = raw as CustomerPinnedKey[];
  }
  const pemOf = (path: string | undefined, what: string): string | undefined => {
    if (path === undefined) return undefined;
    try {
      return io.readFile(path);
    } catch {
      io.err(`attesta:verify-pack: ${what} ${JSON.stringify(path)} cannot be read`);
      throw new Error('unreadable');
    }
  };
  let rekorLogKeyPem: string | undefined;
  let tsaAnchorsPem: string | undefined;
  try {
    rekorLogKeyPem = pemOf(args.rekorLogKey, 'rekor log key file');
    tsaAnchorsPem = pemOf(args.tsaAnchors, 'tsa anchors file');
  } catch {
    return 2;
  }
  // Fail early with a clear message when the auditor's own files do not parse.
  try {
    if (rekorLogKeyPem !== undefined) loadLogPublicKey(rekorLogKeyPem);
  } catch {
    io.err('attesta:verify-pack: the Rekor log key file is not a usable public key');
    return 2;
  }
  try {
    if (tsaAnchorsPem !== undefined) loadTrustAnchors(tsaAnchorsPem);
  } catch {
    io.err('attesta:verify-pack: the TSA anchors file holds no usable certificates');
    return 2;
  }
  let state: StateFile | undefined;
  if (args.state !== undefined) {
    try {
      state = readStateFile(io, args.state);
    } catch (err) {
      io.err(`attesta:verify-pack: ${err instanceof Error ? err.message : 'the state file cannot be read'}`);
      return 2;
    }
  }
  const report = verifyEvidencePack(download, {
    pinnedRootKeyids: args.rootKeyids,
    ...(customerPins !== undefined ? { customerPins } : {}),
    ...(rekorLogKeyPem !== undefined ? { rekorLogKeyPem } : {}),
    ...(tsaAnchorsPem !== undefined ? { tsaAnchorsPem } : {}),
    ...(state !== undefined ? { lastTrusted: state.lastTrusted } : {}),
    ...(state?.trustedTimeFloor !== undefined ? { trustedTimeFloor: state.trustedTimeFloor as string } : {}),
    now: io.now().toISOString(),
  });
  if (args.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    printHuman(io, report);
  }
  // Persist the accepted trust documents (trust.md "Consumers"): merge, never replace.
  if (args.state !== undefined && report.checks.some((c) => c.id === 'trust_and_signature' && c.status === 'passed')
    && (report.trusted !== undefined || report.trustedTime !== undefined)) {
    const merged: Record<string, TrustedDocumentRef> = { ...(state?.lastTrusted ?? {}), ...(report.trusted ?? {}) };
    const next: StateFile = {
      lastTrusted: merged,
      ...(report.trustedTime !== undefined
        ? { trustedTimeFloor: report.trustedTime }
        : state?.trustedTimeFloor !== undefined
          ? { trustedTimeFloor: state.trustedTimeFloor as string }
          : {}),
    };
    try {
      const dir = dirname(args.state);
      const tmp = join(dir === '' ? '.' : dir, `.verify-state-${process.pid}.tmp`);
      io.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
      io.renameFile(tmp, args.state);
    } catch {
      io.err('attesta:verify-pack: the state file could not be written');
      return 2;
    }
  }
  return report.exit_code;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? `attesta:verify-pack: ${error.message}` : 'attesta:verify-pack: failed');
      process.exitCode = 2;
    },
  );
}
