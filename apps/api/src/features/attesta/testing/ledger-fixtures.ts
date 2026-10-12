/**
 * Synthetic ledger fixtures for the Task15d unit tests and the IT-T15d live verifier.
 * Statements carry only the fields the ledger reads (it does not validate the
 * predicate schema; the builder does, A15.8). No customer data.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { GENESIS_PREV_HASH, canonicalize, computeRecordHash, sha256Prefixed } from '../canonical';
import { IN_TOTO_PAYLOAD_TYPE, pae, type DsseEnvelope } from '../dsse';
import {
  AI_PROVENANCE_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  LEDGER_RECORD_KIND,
  buildCanonicalRecord,
  type AttestaStatementKind,
  type ChainStatementInput,
} from '../ledger';
import type { ChainHeadState, LedgerRow } from '../verify-chain';

export interface TestKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  spki: Buffer;
  keyid: string;
}

export function makeTestKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey, spki, keyid: sha256Prefixed(spki) };
}

/** A 40-hex commit sha derived from a label. */
export const shaOf = (label: string | number): string => createHash('sha1').update(String(label)).digest('hex');

export interface StatementOptions {
  repositoryId: string;
  subjectSha: string;
  kind?: AttestaStatementKind;
  previous?: Array<{ digest: string; statement_kind: AttestaStatementKind }>;
  /** Makes otherwise identical statements distinct (a real build differs by as_of). */
  asOf?: string;
}

/** The canonical bytes of a minimal ai-provenance statement. */
export function makeStatement(o: StatementOptions): string {
  return canonicalize({
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: `trackai:repository/${o.repositoryId}/commit/${o.subjectSha}`, digest: { gitCommit: o.subjectSha } }],
    predicateType: AI_PROVENANCE_PREDICATE_TYPE,
    predicate: {
      statement_kind: o.kind ?? 'commit_observed',
      as_of: o.asOf ?? '2026-10-12T10:00:00.000Z',
      repository: { id: o.repositoryId, provider: 'github', url_sha256: { availability: 'unavailable', reason: 'not_captured_yet' } },
      commit: { sha: o.subjectSha },
      previous: o.previous ?? [],
    },
  });
}

export function signStatement(statementCanonical: string, key: TestKey): { envelope: DsseEnvelope; signatureDer: Buffer } {
  const payload = Buffer.from(statementCanonical, 'utf8');
  const signatureDer = sign('sha256', pae(IN_TOTO_PAYLOAD_TYPE, payload), { key: key.privateKey, dsaEncoding: 'der' });
  return {
    signatureDer,
    envelope: {
      payload: payload.toString('base64'),
      payloadType: IN_TOTO_PAYLOAD_TYPE,
      signatures: [{ keyid: key.keyid, sig: signatureDer.toString('base64') }],
    },
  };
}

/** A complete, valid chainStatement input for `statementCanonical`. */
export function chainInput(
  tenantId: string,
  statementCanonical: string,
  key: TestKey,
  extra: Partial<ChainStatementInput> = {},
): ChainStatementInput {
  const { envelope, signatureDer } = signStatement(statementCanonical, key);
  const previous = (JSON.parse(statementCanonical).predicate.previous as Array<{ digest: string }>).map((p) => p.digest);
  return {
    tenantId,
    statementCanonical,
    envelope,
    credentialId: 'it-local-dev',
    keyid: key.keyid,
    signatureDer,
    publicKeySpkiDer: key.spki,
    previousSeen: previous,
    ...extra,
  };
}

export interface BuiltChain {
  rows: LedgerRow[];
  head: ChainHeadState;
}

const FAKE_SIG = Buffer.alloc(70, 7);

/**
 * An in-memory chain of `n` records built exactly as chainStatement builds them.
 * With `key`, every envelope is really signed; otherwise envelopes carry a fixed
 * fake signature (fine whenever signatures are not checked).
 */
export function buildChain(n: number, opts: { tenantId: string; repositoryId: string; key?: TestKey }): BuiltChain {
  const rows: LedgerRow[] = [];
  let prev = GENESIS_PREV_HASH;
  const base = Date.parse('2026-10-12T10:00:00.000Z');
  for (let seq = 0; seq < n; seq++) {
    const subjectSha = shaOf(seq);
    const statementCanonical = makeStatement({ repositoryId: opts.repositoryId, subjectSha });
    const statementDigest = sha256Prefixed(Buffer.from(statementCanonical, 'utf8'));
    const recordedAt = new Date(base + seq).toISOString();
    const canonicalRecord = buildCanonicalRecord({
      seq, prev_hash: prev, recorded_at: recordedAt, tenant_id: opts.tenantId, record_kind: LEDGER_RECORD_KIND,
      statement_digest: statementDigest, predicate_type: AI_PROVENANCE_PREDICATE_TYPE, statement_kind: 'commit_observed',
      repository_id: opts.repositoryId, subject_sha: subjectSha, outbox_subject_id: null,
    });
    const recordHash = computeRecordHash(canonicalRecord, prev);
    let envelope: DsseEnvelope;
    let sigB64: string;
    if (opts.key) {
      const signed = signStatement(statementCanonical, opts.key);
      envelope = signed.envelope;
      sigB64 = signed.signatureDer.toString('base64');
    } else {
      sigB64 = FAKE_SIG.toString('base64');
      envelope = {
        payload: Buffer.from(statementCanonical, 'utf8').toString('base64'),
        payloadType: IN_TOTO_PAYLOAD_TYPE,
        signatures: [{ keyid: 'sha256:' + 'f'.repeat(64), sig: sigB64 }],
      };
    }
    rows.push({
      seq, tenantId: opts.tenantId, prevHash: prev, recordHash, canonicalRecord, recordedAt,
      recordKind: LEDGER_RECORD_KIND, statementDigest, predicateType: AI_PROVENANCE_PREDICATE_TYPE,
      statementKind: 'commit_observed', repositoryId: opts.repositoryId, subjectSha, outboxSubjectId: null,
      statementCanonical, envelope, envelopeKeyid: envelope.signatures[0].keyid,
      envelopePayloadType: IN_TOTO_PAYLOAD_TYPE, envelopeSignatureB64: sigB64,
    });
    prev = recordHash;
  }
  return { rows, head: { next_seq: n, head_hash: prev } };
}
