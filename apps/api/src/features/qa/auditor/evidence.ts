/**
 * Evidence for the auditor's verifiable answers (A16.13a; prompt item 1): the
 * statements actually behind a figure, in the shape RP-1 froze in
 * docs/contracts/attesta/period-report.md. The `statements_root` is
 * `digestsRoot` from period-report-rules.ts — the same RFC 6962 root Attesta
 * signs — computed the same way the Task19 auditor checks recompute it, so an
 * envelope's root always matches the records the envelope itself carries.
 *
 * Hard cap: one figure lists at most 50 000 records. Above that the records
 * are truncated (the caller makes the figure `partial` with `evidence_truncated`);
 * the root then covers exactly the listed records, so it still recomputes.
 */
import { digestsRoot } from '../../attesta/period-report-rules';
import type { QaEvidence } from '../types';

/** One ledger record: the statement's position in the tenant's sealed ledger and its digest. */
export interface EvidenceRecordInput {
  seq: number;
  digest: string;
}

/** The evidence cap (docs/contracts/qa/README.md rule 2). */
export const MAX_EVIDENCE_RECORDS = 50_000;

/**
 * Whether a figure's inputs exceed the cap, so its records are truncated. True
 * when more distinct records exist than MAX_EVIDENCE_RECORDS can list.
 */
export function evidenceTruncated(distinctCount: number): boolean {
  return distinctCount > MAX_EVIDENCE_RECORDS;
}

/**
 * RP-1 evidence over ledger records: de-duplicated (one statement counts once,
 * keeping its lowest `seq`), sorted by `seq` ascending, capped at
 * MAX_EVIDENCE_RECORDS. With no records at all the root is the empty tree's
 * root, the same as Attesta signs. Stable: whatever the call site's input
 * order, the same records give the same evidence array, so two figures of one
 * answer can be compared record-set by record-set.
 */
export function evidenceOf(records: readonly EvidenceRecordInput[]): QaEvidence {
  const firstByDigest = new Map<string, number>();
  for (const record of records) {
    const known = firstByDigest.get(record.digest);
    if (known === undefined) firstByDigest.set(record.digest, record.seq);
    else firstByDigest.set(record.digest, Math.min(known, record.seq));
  }
  const distinct = [...firstByDigest.entries()]
    .map(([digest, seq]) => ({ digest, seq }))
    .sort((a, b) => a.seq - b.seq);
  const capped = distinct.slice(0, MAX_EVIDENCE_RECORDS).map(({ digest, seq }) => ({ digest, seq }));
  return {
    count: capped.length,
    statements_root: digestsRoot(capped.map((r) => r.digest)),
    records: capped,
  };
}
