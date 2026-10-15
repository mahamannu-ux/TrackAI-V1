/**
 * `npm run audit:verify-export -w apps/api -- --export <download.json>
 *   (--root-keyid sha256:… … | --customer-pin <file>)
 *   [--rekor-log-key <pem>] [--tsa-anchors <pem>] [--rekor-log-index-offsets <json>] [--json]`
 *
 * Offline audit-export check (Task16f2, A16.7 finishing work): an auditor runs
 * this on a laptop with no TrackAI account and no network. It reads the files,
 * calls the pure `verifyAuditExport`, prints a short human summary (one line
 * per check) or the JSON report, and exits with the report's exit code (0 all
 * checked and passed, 1 a break, 2 something not checkable, for example a
 * pending anchor). An unreadable or invalid file is exit 2 with a clear
 * message, never a stack trace. Only codes and counts are printed: never event
 * details and never key material. There is no flag for `allowUnpinnedRoot` or
 * `production: false`. `--customer-pin` may combine with `--root-keyid`: the
 * pin decides the trust verdict while the root pin feeds the anchor-key
 * windows, so customer-pinned exports can still check anchors.
 *
 * Mirrors features/attesta/attesta-verify-pack-cli.ts (Task15j, A15.10), minus
 * its `--state` flag (no persisted trust here). `--rekor-log-index-offsets`
 * is parsed exactly as the pack CLI parses it: rekor.sigstage.dev shards its
 * tree, so a sharded log needs its pinned offsets or genuine rows read invalid.
 */
import { readFileSync } from 'node:fs';
import { verifyAuditExport, type AuditExportReport } from './offline-export-verifier';
import type { CustomerPinnedKey } from '../attesta/trust-contract';
import { loadLogPublicKey } from '../attesta/anchor-rekor';
import { loadTrustAnchors } from '../attesta/anchor-tsa';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Injectable side effects (tests hand in memory files). */
export interface VerifyExportIo {
  readFile: (path: string) => string;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
}

const defaultIo = (): VerifyExportIo => ({
  readFile: (p) => readFileSync(p, 'utf8'),
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  now: () => new Date(),
});

interface ParsedArgs {
  export?: string;
  rootKeyids: string[];
  customerPin?: string;
  rekorLogKey?: string;
  tsaAnchors?: string;
  rekorLogIndexOffsets?: string;
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
      case 'export': {
        if (out.export !== undefined) throw new Error('--export given twice');
        out.export = value('export');
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
      case 'rekor-log-index-offsets': {
        if (out.rekorLogIndexOffsets !== undefined) throw new Error('--rekor-log-index-offsets given twice');
        out.rekorLogIndexOffsets = value('rekor-log-index-offsets');
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

function readJsonFile(io: VerifyExportIo, path: string, what: string): unknown {
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

/** Pinned Rekor shard offsets from a JSON file (`{"<decimal tree id>": <offset>}`). */
function readOffsetsFile(io: VerifyExportIo, path: string): Record<string, number> {
  const raw = readJsonFile(io, path, 'rekor log index offsets file');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`rekor log index offsets file ${JSON.stringify(path)} must be an object of "<decimal tree id>": <offset>`);
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    let treeOk = /^[0-9]{1,20}$/.test(k);
    try {
      treeOk = treeOk && BigInt(k) <= 0xffffffffffffffffn;
    } catch {
      treeOk = false;
    }
    if (!treeOk || typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      throw new Error(`rekor log index offsets file ${JSON.stringify(path)} must be an object of "<decimal tree id>": <non-negative integer>`);
    }
  }
  return raw as Record<string, number>;
}

function printHuman(io: VerifyExportIo, report: AuditExportReport): void {
  for (const check of report.checks) {
    io.out(`${check.id}: ${check.status}${check.detail_code !== undefined ? ` code=${check.detail_code}` : ''}`);
  }
  io.out(`unsealed: count=${report.unsealed.count}`);
  const kinds = new Map<string, number>();
  for (const b of report.breaks) kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1);
  io.out(`breaks: ${report.breaks.length}${[...kinds.entries()].map(([kind, n]) => ` ${kind}=${n}`).join('')}`);
  io.out(`result: exit ${report.exit_code}`);
}

/** Run the command; returns the process exit code (never throws key material or a stack). */
export async function main(argv: string[], io: VerifyExportIo = defaultIo()): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    io.err(`audit:verify-export: ${err instanceof Error ? err.message : 'bad arguments'}`);
    return 2;
  }
  if (args.export === undefined) {
    io.err('audit:verify-export: --export <download.json> is required');
    return 2;
  }
  if (args.rootKeyids.length === 0 && args.customerPin === undefined) {
    io.err('audit:verify-export: give --root-keyid sha256:… (repeatable) or --customer-pin <file>');
    return 2;
  }
  for (const keyid of args.rootKeyids) {
    if (!DIGEST_RE.test(keyid)) {
      io.err('audit:verify-export: --root-keyid must be sha256:<64 hex>');
      return 2;
    }
  }
  let download: unknown;
  try {
    download = readJsonFile(io, args.export, 'export file');
  } catch (err) {
    io.err(`audit:verify-export: ${err instanceof Error ? err.message : 'the export file cannot be read'}`);
    return 2;
  }
  let customerPins: readonly CustomerPinnedKey[] | undefined;
  if (args.customerPin !== undefined) {
    let raw: unknown;
    try {
      raw = readJsonFile(io, args.customerPin, 'customer pin file');
    } catch (err) {
      io.err(`audit:verify-export: ${err instanceof Error ? err.message : 'the customer pin file cannot be read'}`);
      return 2;
    }
    if (!Array.isArray(raw)) {
      io.err('audit:verify-export: the customer pin file must be a JSON array of key entries');
      return 2;
    }
    customerPins = raw as CustomerPinnedKey[];
  }
  const pemOf = (path: string | undefined, what: string): string | undefined => {
    if (path === undefined) return undefined;
    try {
      return io.readFile(path);
    } catch {
      io.err(`audit:verify-export: ${what} ${JSON.stringify(path)} cannot be read`);
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
  let rekorLogIndexOffsets: Record<string, number> | undefined;
  if (args.rekorLogIndexOffsets !== undefined) {
    try {
      rekorLogIndexOffsets = readOffsetsFile(io, args.rekorLogIndexOffsets);
    } catch (err) {
      io.err(`audit:verify-export: ${err instanceof Error ? err.message : 'the offsets file cannot be read'}`);
      return 2;
    }
  }
  // Fail early with a clear message when the auditor's own files do not parse.
  try {
    if (rekorLogKeyPem !== undefined) loadLogPublicKey(rekorLogKeyPem);
  } catch {
    io.err('audit:verify-export: the Rekor log key file is not a usable public key');
    return 2;
  }
  try {
    if (tsaAnchorsPem !== undefined) loadTrustAnchors(tsaAnchorsPem);
  } catch {
    io.err('audit:verify-export: the TSA anchors file holds no usable certificates');
    return 2;
  }
  const report = verifyAuditExport(download, {
    pinnedRootKeyids: args.rootKeyids,
    ...(customerPins !== undefined ? { customerPins } : {}),
    ...(rekorLogKeyPem !== undefined ? { rekorLogKeyPem } : {}),
    ...(tsaAnchorsPem !== undefined ? { tsaAnchorsPem } : {}),
    ...(rekorLogIndexOffsets !== undefined ? { rekorLogIndexOffsets } : {}),
    now: io.now().toISOString(),
  });
  if (args.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    printHuman(io, report);
  }
  if (report.verifier_error !== undefined) {
    io.err(`verifier error: ${report.verifier_error}`);
  }
  return report.exit_code;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? `audit:verify-export: ${error.message}` : 'audit:verify-export: failed');
      process.exitCode = 2;
    },
  );
}
