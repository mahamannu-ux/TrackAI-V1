'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AttestaApiError,
  downloadEvidencePack,
  getEvidencePack,
  requestEvidencePack,
  verifyAttestaChain,
  type AttestaPackJob,
  type AttestaVerifyBreak,
  type AttestaVerifyReport,
  type Repository,
} from '@/lib/api';
import { formatAttestaDate } from './attestation-card';

function Badge({ children, tone = 'slate' }: {
  children: React.ReactNode; tone?: 'slate' | 'green' | 'amber' | 'rose';
}) {
  const styles = {
    slate: 'bg-slate-800 text-slate-300',
    green: 'bg-emerald-500/10 text-emerald-300',
    amber: 'bg-amber-500/10 text-amber-300',
    rose: 'bg-rose-500/10 text-rose-200',
  };
  return <span className={`rounded-full px-2.5 py-1 text-xs ${styles[tone]}`}>{children}</span>;
}

function verifyVerdict(report: AttestaVerifyReport): 'verified' | 'anchors_not_checked' | 'not_checkable' | 'problems' {
  if (report.ok) {
    return report.anchors.status === 'not_checked' ? 'anchors_not_checked' : 'verified';
  }
  if (report.breaks.length === 0) return 'not_checkable';
  const uncheckable = new Set(['ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED', 'ATTESTA_VERIFY_NOT_CHECKABLE']);
  if (report.breaks.every((item) => uncheckable.has(item.detail_code))) {
    return 'not_checkable';
  }
  return 'problems';
}

function problemRecordCount(breaks: AttestaVerifyBreak[]): number {
  return new Set(breaks.map((item) => item.seq)).size;
}

function breakLabel(code: string): string {
  if (code === 'ATTESTA_VERIFY_SEQ_GAP') return 'A record is missing';
  if (code === 'ATTESTA_VERIFY_PREV_HASH_MISMATCH') return 'Link to the previous record is broken';
  if (code === 'ATTESTA_VERIFY_RECORD_HASH_MISMATCH') return 'Record content changed';
  if (code === 'ATTESTA_VERIFY_STATEMENT_DIGEST_MISMATCH') return 'Statement content changed';
  if (code === 'ATTESTA_VERIFY_SIGNATURE_INVALID') return 'Signature does not verify';
  if (code === 'ATTESTA_VERIFY_KEY_UNKNOWN') return 'Signed with an unknown key';
  if (code === 'ATTESTA_VERIFY_KEY_NOT_VALID_AT') return 'Key was not valid at that time';
  if (code === 'ATTESTA_VERIFY_MERKLE_PROOF_INVALID') return 'Anchor proof does not match';
  if (code === 'ATTESTA_VERIFY_ANCHOR_INVALID') return 'Anchor does not verify';
  if (code === 'ATTESTA_VERIFY_ANCHOR_MISSING') return 'Not anchored in time';
  if (code === 'ATTESTA_VERIFY_SIGNATURES_NOT_CHECKED') return 'Signatures not checked';
  if (code === 'ATTESTA_VERIFY_NOT_CHECKABLE') return 'Not checkable';
  return 'Other problem';
}

function packScopeSummary(
  job: AttestaPackJob,
  repositories: Repository[],
): string {
  const repositoryName = job.scope.repository_id
    ? repositories.find((repository) => repository.id === job.scope.repository_id)?.name
      ?? job.scope.repository_id.slice(0, 8)
    : 'All repositories';
  const mode = job.mode === 'repository_only' ? 'Repository only' : 'Full';
  return `${repositoryName} · ${formatAttestaDate(job.scope.from)} → ${formatAttestaDate(job.scope.to)} · ${mode}`;
}

function packStatusTone(status: AttestaPackJob['status']): 'slate' | 'green' | 'rose' {
  if (status === 'ready') return 'green';
  if (status === 'failed') return 'rose';
  return 'slate';
}

function BreakList({ breaks }: { breaks: AttestaVerifyBreak[] }) {
  if (breaks.length === 0) return null;
  const shown = breaks.slice(0, 50);
  return <div className="mt-3 space-y-1">
    {shown.map((item, index) => <div key={`${item.seq}-${item.detail_code}-${index}`} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-mono text-xs text-slate-400">#{item.seq}</span>
      <span className="text-slate-300">{breakLabel(item.detail_code)}</span>
      <span className="font-mono text-xs text-slate-500">{item.detail_code}</span>
    </div>)}
    {breaks.length > 50 && <div className="text-xs text-slate-500">and {breaks.length - 50} more</div>}
  </div>;
}

export function AttestaWorkspace({ repositories }: { repositories: Repository[] }) {
  const [fromSeq, setFromSeq] = useState('');
  const [toSeq, setToSeq] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [report, setReport] = useState<AttestaVerifyReport | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [packRepositoryId, setPackRepositoryId] = useState('');
  const [packFrom, setPackFrom] = useState('');
  const [packTo, setPackTo] = useState('');
  const [packMode, setPackMode] = useState<'full' | 'repository_only'>('full');
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AttestaPackJob[]>([]);
  const [pollErrors, setPollErrors] = useState<Record<string, string>>({});
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function verify(): Promise<void> {
    setVerifying(true);
    setVerifyError(null);
    setReport(null);
    try {
      const range: { fromSeq?: number; toSeq?: number } = {};
      if (fromSeq.trim() !== '') range.fromSeq = Number(fromSeq);
      if (toSeq.trim() !== '') range.toSeq = Number(toSeq);
      const result = await verifyAttestaChain(range);
      if (mountedRef.current) setReport(result);
    } catch (cause) {
      if (!mountedRef.current) return;
      if (cause instanceof AttestaApiError) {
        if (cause.status === 429) {
          setVerifyError('A verification is already running for your organization. Try again in a few seconds.');
        } else if (cause.status === 400) {
          setVerifyError('That range is too large or invalid. Choose at most 10 000 records with From/To.');
        } else {
          setVerifyError(`Verification unavailable (code ${cause.code}, request ${cause.requestId ?? 'unknown'}).`);
        }
      } else {
        setVerifyError(cause instanceof Error ? cause.message : 'Verification unavailable.');
      }
    } finally {
      if (mountedRef.current) setVerifying(false);
    }
  }

  async function pollJob(id: string): Promise<void> {
    const deadline = Date.now() + 10 * 60 * 1000;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (!mountedRef.current) return;
      if (Date.now() >= deadline) {
        setPollErrors((current) => ({ ...current, [id]: 'Status unavailable (code ATTESTA_API_INTERNAL). Refresh the page to check again.' }));
        return;
      }
      let job: AttestaPackJob;
      try {
        job = await getEvidencePack(id);
      } catch (cause) {
        if (!mountedRef.current) return;
        const code = cause instanceof AttestaApiError ? cause.code : 'ATTESTA_API_INTERNAL';
        setPollErrors((current) => ({ ...current, [id]: `Status unavailable (code ${code}). Refresh the page to check again.` }));
        return;
      }
      if (!mountedRef.current) return;
      setJobs((current) => current.map((row) => (row.id === id ? job : row)));
      if (job.status === 'ready' || job.status === 'failed') return;
    }
  }

  async function startPackJob(body: { repository_id?: string; from: string; to: string; mode: string }): Promise<void> {
    setRequestBusy(true);
    setRequestError(null);
    try {
      const created = await requestEvidencePack(body, crypto.randomUUID());
      const job = await getEvidencePack(created.id);
      if (!mountedRef.current) return;
      setJobs((current) => [job, ...current.filter((row) => row.id !== job.id)]);
      if (job.status !== 'ready' && job.status !== 'failed') void pollJob(job.id);
    } catch (cause) {
      if (!mountedRef.current) return;
      setRequestError(cause instanceof Error ? cause.message : 'Export failed.');
    } finally {
      if (mountedRef.current) setRequestBusy(false);
    }
  }

  async function requestPack(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const from = new Date(packFrom);
    const to = new Date(packTo);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
      setRequestError('Choose a From and To date and time.');
      return;
    }
    const mode = packRepositoryId ? packMode : 'full';
    await startPackJob({
      ...(packRepositoryId ? { repository_id: packRepositoryId } : {}),
      from: from.toISOString(),
      to: to.toISOString(),
      mode,
    });
  }

  async function retryJob(job: AttestaPackJob): Promise<void> {
    await startPackJob({
      ...(job.scope.repository_id ? { repository_id: job.scope.repository_id } : {}),
      from: job.scope.from,
      to: job.scope.to,
      mode: job.mode,
    });
  }

  async function downloadJob(job: AttestaPackJob): Promise<void> {
    if (!job.content_path) return;
    setDownloadingId(job.id);
    setRequestError(null);
    try {
      const blob = await downloadEvidencePack(job.content_path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `trackai-evidence-pack-${job.id}.json`;
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (cause) {
      if (mountedRef.current) {
        setRequestError(cause instanceof Error ? cause.message : 'Evidence pack download failed.');
      }
    } finally {
      if (mountedRef.current) setDownloadingId(null);
    }
  }

  const verdict = report ? verifyVerdict(report) : null;

  return <div className="space-y-4">
    <div>
      <h2 className="font-semibold text-white">Attestation</h2>
      <p className="mt-1 text-sm text-slate-500">Verify the signed ledger and export evidence.</p>
    </div>

    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="font-semibold text-white">Verify chain</h3>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <label className="block text-xs text-slate-400">From record (optional)
          <input type="number" min={0} value={fromSeq} onChange={(event) => setFromSeq(event.target.value)} placeholder="First record" aria-label="From record" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-slate-400">To record (optional)
          <input type="number" min={0} value={toSeq} onChange={(event) => setToSeq(event.target.value)} placeholder="Last record" aria-label="To record" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
        </label>
        <div className="flex items-end">
          <button onClick={() => void verify()} disabled={verifying} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{verifying ? 'Verifying…' : 'Verify chain'}</button>
        </div>
      </div>
      {verifyError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{verifyError}</div>}
      {report && verdict === 'verified' && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-200">Chain verified: {report.checked} records. Signatures and anchors checked.</div>}
      {report && verdict === 'anchors_not_checked' && <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">Signatures checked; anchors not checked on this server.</div>}
      {report && verdict === 'not_checkable' && <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">Not fully checkable: {report.checked} records read; some checks could not run.<BreakList breaks={report.breaks} /></div>}
      {report && verdict === 'problems' && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">Verification found problems in {problemRecordCount(report.breaks)} records.<BreakList breaks={report.breaks} /></div>}
    </section>

    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="font-semibold text-white">Export evidence pack</h3>
      <form onSubmit={(event) => void requestPack(event)} className="space-y-3">
        <label className="block text-xs text-slate-400">Repository
          <select value={packRepositoryId} onChange={(event) => setPackRepositoryId(event.target.value)} aria-label="Repository" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
            <option value="">All repositories</option>
            {repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.name}</option>)}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-slate-400">From
            <input type="datetime-local" required value={packFrom} onChange={(event) => setPackFrom(event.target.value)} aria-label="From" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
          </label>
          <label className="block text-xs text-slate-400">To
            <input type="datetime-local" required value={packTo} onChange={(event) => setPackTo(event.target.value)} aria-label="To" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
          </label>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs text-slate-400">Mode</legend>
          <label className="flex items-start gap-2 text-sm text-slate-300">
            <input type="radio" name="pack-mode" checked={packMode === 'full'} onChange={() => setPackMode('full')} className="mt-1" />
            <span>Full (default): proves nothing was left out; shows other repositories&apos; record metadata (IDs, commit hashes), never their content</span>
          </label>
          <label className={`flex items-start gap-2 text-sm ${packRepositoryId ? 'text-slate-300' : 'text-slate-600'}`}>
            <input type="radio" name="pack-mode" checked={packMode === 'repository_only'} disabled={!packRepositoryId} onChange={() => setPackMode('repository_only')} className="mt-1" />
            <span>Repository only: for outsiders; hides other repositories; completeness cannot be proven</span>
          </label>
        </fieldset>
        {requestError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{requestError}</div>}
        <button disabled={requestBusy} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{requestBusy ? 'Exporting…' : 'Export evidence pack'}</button>
      </form>
      <p className="text-xs text-slate-600">Packs requested in this tab. The API has no pack list yet.</p>
      {jobs.length > 0 && <div className="space-y-2">
        {jobs.map((job) => <div key={job.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge tone={packStatusTone(job.status)}>{job.status}</Badge>
            <span className="text-xs text-slate-500">{packScopeSummary(job, repositories)}</span>
          </div>
          {job.counts && <div className="mt-2 text-xs text-slate-500">{job.counts.statements} statements · {job.counts.anchored} anchored · {job.counts.pending} pending</div>}
          {pollErrors[job.id] && <div className="mt-2 text-xs text-amber-300">{pollErrors[job.id]}</div>}
          {job.status === 'ready' && <div className="mt-3 space-y-2">
            {job.pack_digest && <div className="break-all font-mono text-xs text-slate-400">{job.pack_digest}</div>}
            {job.counts && job.counts.pending > 0 && <div className="text-xs text-amber-300">{job.counts.pending} statements were not yet anchored; the pack says so.</div>}
            <button disabled={downloadingId !== null || !job.content_path} onClick={() => void downloadJob(job)} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 disabled:opacity-50">{downloadingId === job.id ? 'Downloading…' : 'Download'}</button>
          </div>}
          {job.status === 'failed' && <div className="mt-3 space-y-2">
            <div className="text-sm text-rose-200">Export failed (code <span className="font-mono">{job.error_code ?? 'unknown'}</span>).</div>
            {job.retryable && <button disabled={requestBusy} onClick={() => void retryJob(job)} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 disabled:opacity-50">Try again</button>}
          </div>}
        </div>)}
      </div>}
    </section>
  </div>;
}
