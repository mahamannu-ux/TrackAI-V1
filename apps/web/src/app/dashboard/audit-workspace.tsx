'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AuditApiError,
  downloadAuditExport,
  getAuditCatalog,
  getAuditExport,
  listAuditEvents,
  requestAuditExport,
  verifyAuditTrail,
  type AuditCatalog,
  type AuditEvent,
  type AuditExportJob,
  type AuditFilters,
  type AuditVerifyBreak,
  type AuditVerifyReport,
  type Repository,
} from '@/lib/api';
import { AttestaWorkspace } from './attesta-workspace';

const ACTOR_LABELS: Record<string, string> = {
  tenant_admin: 'admin',
  tenant_auditor: 'auditor',
  tenant_user: 'signed-in user',
  system_operator: 'operator',
  machine: 'machine',
  service: 'service',
};

const ACTOR_TYPES = Object.keys(ACTOR_LABELS);

const MAX_ACTIONS = 20;

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

function severityTone(severity: AuditEvent['severity']): 'slate' | 'amber' | 'rose' {
  if (severity === 'high') return 'rose';
  if (severity === 'notice') return 'amber';
  return 'slate';
}

function localTime(value: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function truncateId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function actorLabel(actorType: string): string {
  return ACTOR_LABELS[actorType] ?? actorType;
}

type FormState = {
  from: string;
  to: string;
  severity: '' | 'high' | 'notice' | 'info';
  actions: string[];
  actorType: string;
  actorId: string;
  targetType: string;
  targetId: string;
  showReadReceipts: boolean;
};

const EMPTY_FORM: FormState = {
  from: '',
  to: '',
  severity: '',
  actions: [],
  actorType: '',
  actorId: '',
  targetType: '',
  targetId: '',
  showReadReceipts: false,
};

/** Read receipts are hidden unless the toggle is on; the toggle is part of the applied filters. */
const READ_RECEIPTS_ACTION = 'audit.events.read';

function toFilters(form: FormState): AuditFilters {
  return {
    actions: [...form.actions],
    excludeActions: form.showReadReceipts ? [] : [READ_RECEIPTS_ACTION],
    ...(form.severity ? { severity: form.severity } : {}),
    ...(form.actorType ? { actorType: form.actorType } : {}),
    ...(form.actorId.trim() ? { actorId: form.actorId.trim() } : {}),
    ...(form.targetType ? { targetType: form.targetType } : {}),
    ...(form.targetId.trim() ? { targetId: form.targetId.trim() } : {}),
    ...(form.from ? { from: new Date(form.from).toISOString() } : {}),
    ...(form.to ? { to: new Date(form.to).toISOString() } : {}),
  };
}

function describeError(cause: unknown): { message: string; requestId: string | null; code: string | null } {
  if (cause instanceof AuditApiError) {
    if (cause.status === 403) {
      return {
        message: 'Audit access needs an administrator or auditor membership.',
        requestId: cause.requestId,
        code: cause.code,
      };
    }
    return { message: cause.message, requestId: cause.requestId, code: cause.code };
  }
  return { message: cause instanceof Error ? cause.message : 'Audit search failed.', requestId: null, code: null };
}

function DetailValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) {
    return <span className="text-slate-500">none</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-500">none</span>;
    if (value.every(item => item === null || typeof item !== 'object')) {
      return <span>{value.map(item => item === null ? 'none' : String(item)).join(', ')}</span>;
    }
    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <div key={index} className="border-l border-slate-800 pl-3">
            <DetailValue value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-slate-500">none</span>;
    return (
      <dl className={`space-y-1.5 ${depth > 0 ? 'border-l border-slate-800 pl-3' : ''}`}>
        {entries.map(([key, nested]) => (
          <div key={key}>
            <dt className="font-mono text-xs text-slate-500">{key}</dt>
            <dd className="mt-0.5 text-sm text-slate-200"><DetailValue value={nested} depth={depth + 1} /></dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

function EventDrawer({ event, owner, onClose }: {
  event: AuditEvent; owner: string; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function copyEventId(): void {
    setCopied(false);
    setCopyFailed(false);
    void navigator.clipboard.writeText(event.id).then(
      () => setCopied(true),
      () => setCopyFailed(true),
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        role="dialog"
        aria-label={`Audit event ${event.action}`}
        className="h-full w-full max-w-xl overflow-y-auto border-l border-slate-800 bg-slate-950 p-7 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-mono text-sm text-violet-300">{event.action}</div>
            <div className="mt-2 flex items-center gap-2">
              <Badge tone={severityTone(event.severity)}>{event.severity}</Badge>
              <span className="text-xs text-slate-500">Recorded by {owner}</span>
            </div>
          </div>
          <button ref={closeRef} onClick={onClose} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300">Close</button>
        </div>

        <dl className="mt-6 space-y-4">
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">When</dt>
            <dd className="mt-1 text-sm text-slate-200">{localTime(event.occurred_at)} <span className="text-xs text-slate-500">({event.occurred_at})</span></dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">Who</dt>
            <dd className="mt-1 text-sm text-slate-200">{actorLabel(event.actor_type)} <span className="break-all font-mono text-xs text-slate-400">{event.actor_id}</span></dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">What it acted on</dt>
            <dd className="mt-1 text-sm text-slate-200">{event.target_type} <span className="break-all font-mono text-xs text-slate-400">{event.target_id}</span></dd>
          </div>
        </dl>

        <section className="mt-6">
          <h3 className="text-xs uppercase tracking-wider text-slate-500">Details</h3>
          <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900/60 p-4">
            <DetailValue value={event.details} />
          </div>
        </section>

        <details className="mt-4 rounded-lg border border-slate-800 bg-slate-950/40 text-sm">
          <summary className="cursor-pointer px-4 py-3 text-slate-400 hover:text-white">Technical view</summary>
          <pre className="overflow-auto whitespace-pre-wrap border-t border-slate-800 p-4 font-mono text-xs text-slate-300">{JSON.stringify(event, null, 2)}</pre>
        </details>

        <div className="mt-4 flex items-center gap-3">
          <button onClick={copyEventId} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300">
            {copied ? 'Copied' : 'Copy event id'}
          </button>
          {copyFailed && <span className="text-xs text-amber-300">Browser clipboard access failed; select the id manually.</span>}
        </div>

        <div className="mt-6 border-t border-slate-800 pt-4 text-xs text-slate-600">Catalog version {event.catalog_version}</div>
      </aside>
    </div>
  );
}

function toLocalInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function thirtyDaysAgo(): Date {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

function breakLabel(kind: AuditVerifyBreak['kind']): string {
  if (kind === 'missing_row') return 'event missing';
  if (kind === 'changed_row') return 'event changed';
  if (kind === 'unsealed_row_in_sealed_window') return 'event added after sealing';
  if (kind === 'broken_previous') return 'seal chain broken';
  return 'seal statement problem';
}

function exportErrorLabel(code: string | null): string {
  if (code === 'AUDIT_EXPORT_TOO_LARGE') return 'Too many events for one export. Narrow the dates and try again.';
  if (code === 'AUDIT_EXPORT_SIGNER_NO_CREDENTIAL') return 'This tenant has no active signing key, so nothing could be signed.';
  if (code === 'AUDIT_EXPORT_SIGNER_UNAVAILABLE') return 'The signer is unavailable. Try again.';
  if (code === 'AUDIT_EXPORT_UNAVAILABLE') return 'The export store is unavailable. Try again.';
  return 'The export failed. Try again.';
}

function requestErrorOf(cause: unknown, fallback: string): { message: string; requestId: string | null } {
  if (cause instanceof AuditApiError) {
    if (cause.status === 403) {
      return { message: 'Audit access needs an administrator or auditor membership.', requestId: cause.requestId };
    }
    return { message: cause.message, requestId: cause.requestId };
  }
  return { message: cause instanceof Error ? cause.message : fallback, requestId: null };
}

function validRange(from: string, to: string): string | null {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 'Choose a valid From and To date and time.';
  if (!(fromMs < toMs)) return 'The To time must be after the From time.';
  return null;
}

function AuditEvidenceSection({ active }: { active: boolean }) {
  const [verifyFrom, setVerifyFrom] = useState(() => toLocalInput(thirtyDaysAgo()));
  const [verifyTo, setVerifyTo] = useState(() => toLocalInput(new Date()));
  const [verifyFormError, setVerifyFormError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [report, setReport] = useState<AuditVerifyReport | null>(null);
  const [verifyError, setVerifyError] = useState<{ message: string; requestId: string | null } | null>(null);

  const [exportFrom, setExportFrom] = useState(() => toLocalInput(thirtyDaysAgo()));
  const [exportTo, setExportTo] = useState(() => toLocalInput(new Date()));
  const [exportFormError, setExportFormError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [job, setJob] = useState<AuditExportJob | null>(null);
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [pollStopped, setPollStopped] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [jobError, setJobError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const jobOpen = job !== null && (job.status === 'queued' || job.status === 'running');

  async function pollOnce(): Promise<void> {
    if (!job) return;
    try {
      setJob(await getAuditExport(job.id));
      setJobError(null);
    } catch (cause) {
      setJobError(requestErrorOf(cause, 'Export status is unavailable.'));
      setPollStopped(true);
    }
  }

  useEffect(() => {
    if (!active || !jobOpen || pollStopped) return;
    if (requestedAt !== null && Date.now() - requestedAt > 5 * 60 * 1000) {
      setTimedOut(true);
      return;
    }
    const id = window.setInterval(() => { void pollOnce(); }, 3000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, job?.id, job?.status, requestedAt, pollStopped]);

  async function check(): Promise<void> {
    const invalid = validRange(verifyFrom, verifyTo);
    if (invalid) {
      setVerifyFormError(invalid);
      return;
    }
    setVerifyFormError(null);
    setVerifying(true);
    setVerifyError(null);
    setReport(null);
    try {
      setReport(await verifyAuditTrail({ from: new Date(verifyFrom).toISOString(), to: new Date(verifyTo).toISOString() }));
    } catch (cause) {
      setVerifyError(requestErrorOf(cause, 'The check failed.'));
    } finally {
      setVerifying(false);
    }
  }

  async function requestExport(): Promise<void> {
    const invalid = validRange(exportFrom, exportTo);
    if (invalid) {
      setExportFormError(invalid);
      return;
    }
    setExportFormError(null);
    setRequesting(true);
    setJobError(null);
    setDownloadError(null);
    setPollStopped(false);
    setTimedOut(false);
    try {
      const created = await requestAuditExport(
        { from: new Date(exportFrom).toISOString(), to: new Date(exportTo).toISOString() },
        crypto.randomUUID(),
      );
      setJob(await getAuditExport(created.id));
      setRequestedAt(Date.now());
    } catch (cause) {
      setJobError(requestErrorOf(cause, 'The export request failed.'));
    } finally {
      setRequesting(false);
    }
  }

  async function downloadExport(): Promise<void> {
    if (!job || job.status !== 'ready' || !job.content_path) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await downloadAuditExport(job.content_path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `audit-export-${job.id}.json`;
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : 'Export download failed.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className={active ? 'space-y-4' : 'hidden'} aria-hidden={!active}>
      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div>
          <h2 className="font-semibold text-white">Check the trail</h2>
          <p className="mt-1 text-sm text-slate-500">Sealed events are rechecked against their seals. Runs only when you press Check.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="block text-xs text-slate-400">From
            <input type="datetime-local" value={verifyFrom} onChange={event => setVerifyFrom(event.target.value)} aria-label="Check from" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
          </label>
          <label className="block text-xs text-slate-400">To
            <input type="datetime-local" value={verifyTo} onChange={event => setVerifyTo(event.target.value)} aria-label="Check to" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
          </label>
          <div className="flex items-end">
            <button onClick={() => void check()} disabled={verifying} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{verifying ? 'Checking…' : 'Check'}</button>
          </div>
        </div>
        {verifyFormError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{verifyFormError}</div>}
        {verifyError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200"><div>{verifyError.message}</div>{verifyError.requestId && <div className="mt-1 text-xs text-rose-200/70">Reference: {verifyError.requestId}</div>}</div>}
        {report && (
          <div className="space-y-3">
            {report.breaks.length === 0 && report.chain.ok && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-200">All sealed events match their seals.</div>}
            {report.breaks.length === 0 && !report.chain.ok && <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">Seals match, but signatures or anchors could not be checked.</div>}
            {report.breaks.length > 0 && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">Problems found.</div>}
            <div className="text-sm text-slate-300">Seals checked: {report.seals_checked} · {report.unsealed_tail.count > 0
              ? `${report.unsealed_tail.count} events not sealed yet.`
              : 'No unsealed events in this window.'}</div>
            {report.breaks.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/60">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                      <tr><th className="px-5 py-3 font-medium">Problem</th><th className="px-5 py-3 font-medium">Seal</th><th className="px-5 py-3 font-medium">Row</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {report.breaks.map((item, index) => (
                        <tr key={`${item.kind}-${item.seal ?? 'none'}-${item.row_id ?? index}`}>
                          <td className="px-5 py-4 text-slate-200">{breakLabel(item.kind)}</td>
                          <td className="px-5 py-4 font-mono text-xs text-slate-400" title={item.seal ?? ''}>{item.seal ? truncateId(item.seal) : 'none'}</td>
                          <td className="px-5 py-4 font-mono text-xs text-slate-400" title={item.row_id ?? ''}>{item.row_id ? truncateId(item.row_id) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {report.breaks_truncated && <div className="text-xs text-slate-500">Showing the first {report.breaks.length} problems.</div>}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div>
          <h2 className="font-semibold text-white">Signed export</h2>
          <p className="mt-1 text-sm text-slate-500">A file an outsider checks offline. Runs only when you press Request export.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="block text-xs text-slate-400">From
            <input type="datetime-local" value={exportFrom} onChange={event => setExportFrom(event.target.value)} aria-label="Export from" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
          </label>
          <label className="block text-xs text-slate-400">To
            <input type="datetime-local" value={exportTo} onChange={event => setExportTo(event.target.value)} aria-label="Export to" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
          </label>
          <div className="flex items-end">
            <button onClick={() => void requestExport()} disabled={requesting} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{requesting ? 'Requesting…' : 'Request export'}</button>
          </div>
        </div>
        {exportFormError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{exportFormError}</div>}
        {jobError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200"><div>{jobError.message}</div>{jobError.requestId && <div className="mt-1 text-xs text-rose-200/70">Reference: {jobError.requestId}</div>}</div>}
        {job && (
          <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge tone={job.status === 'ready' ? 'green' : job.status === 'failed' ? 'rose' : 'slate'}>{job.status}</Badge>
              <span className="text-xs text-slate-500">{jobOpen ? 'Checking status…' : `Finished ${job.finished_at ?? ''}`}</span>
            </div>
            {job.status === 'failed' && <div className="text-sm text-rose-200">{exportErrorLabel(job.error_code)}<div className="mt-1 font-mono text-xs text-rose-200/70">{job.error_code ?? 'unknown'}</div></div>}
            {job.status === 'ready' && (
              <div className="flex items-center gap-3">
                <button onClick={() => void downloadExport()} disabled={downloading} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 disabled:opacity-50">{downloading ? 'Downloading…' : 'Download signed export'}</button>
                {downloadError && <span className="text-xs text-amber-300">{downloadError}</span>}
              </div>
            )}
            {(timedOut || pollStopped) && jobOpen && (
              <button onClick={() => { setPollStopped(false); setTimedOut(false); void pollOnce(); }} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300">Check status</button>
            )}
            {timedOut && jobOpen && <div className="text-xs text-slate-500">Still running after 5 minutes.</div>}
          </div>
        )}
        <p className="text-xs text-slate-600">An outsider checks this file offline with `npm run audit:verify-export`.</p>
      </section>
    </div>
  );
}

type AuditTab = 'trail' | 'evidence' | 'attestation';

const AUDIT_TABS: Array<{ id: AuditTab; label: string; description: string }> = [
  { id: 'trail', label: 'Trail', description: 'Search the audit trail' },
  { id: 'evidence', label: 'Tamper evidence and export', description: 'Check seals and export' },
  { id: 'attestation', label: 'Attestation', description: 'Verify the signed ledger' },
];

export function AuditWorkspace({ role, repositories }: {
  role: 'tenant_admin' | 'tenant_auditor'; repositories: Repository[];
}) {
  const [tab, setTab] = useState<AuditTab>('trail');
  const [catalog, setCatalog] = useState<AuditCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [applied, setApplied] = useState<AuditFilters>({ actions: [], excludeActions: [READ_RECEIPTS_ACTION] });
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [catalogVersion, setCatalogVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  const emittedByOwner = useMemo(() => {
    if (!catalog) return [];
    const groups = new Map<string, string[]>();
    for (const entry of catalog.actions) {
      if (entry.status !== 'emitted') continue;
      const list = groups.get(entry.owner) ?? [];
      list.push(entry.action);
      groups.set(entry.owner, list);
    }
    return [...groups.entries()]
      .map(([owner, actions]) => ({ owner, actions: actions.sort() }))
      .sort((a, b) => a.owner.localeCompare(b.owner));
  }, [catalog]);

  const targetTypes = useMemo(() => {
    if (!catalog) return [];
    return [...new Set(catalog.actions.map(entry => entry.target_type))].sort();
  }, [catalog]);

  async function search(filters: AuditFilters): Promise<void> {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const page = await listAuditEvents(filters);
      setEvents(page.events);
      setCursor(page.next_cursor);
      setCatalogVersion(page.catalog_version);
    } catch (cause) {
      const details = describeError(cause);
      setEvents([]);
      setCursor(null);
      setError({ message: details.message, requestId: details.requestId });
    } finally {
      setLoading(false);
    }
  }

  async function loadMore(): Promise<void> {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    setNotice(null);
    try {
      const page = await listAuditEvents(applied, cursor);
      setEvents(current => [...current, ...page.events]);
      setCursor(page.next_cursor);
      setCatalogVersion(page.catalog_version);
    } catch (cause) {
      if (cause instanceof AuditApiError && cause.code === 'AUDIT_CURSOR_INVALID') {
        setNotice('The list changed while you were reading, so the search started over from the latest events.');
        await search(applied);
      } else {
        const details = describeError(cause);
        setError({ message: details.message, requestId: details.requestId });
      }
    } finally {
      setLoadingMore(false);
    }
  }

  function submitSearch(): void {
    if (form.from && form.to && !(new Date(form.from).getTime() < new Date(form.to).getTime())) {
      setFormError('The To time must be after the From time.');
      return;
    }
    if ((form.from && Number.isNaN(new Date(form.from).getTime()))
      || (form.to && Number.isNaN(new Date(form.to).getTime()))) {
      setFormError('Choose a valid From and To date and time.');
      return;
    }
    setFormError(null);
    const filters = toFilters(form);
    setApplied(filters);
    void search(filters);
  }

  function reset(): void {
    setForm(EMPTY_FORM);
    setFormError(null);
    const filters: AuditFilters = { actions: [], excludeActions: [READ_RECEIPTS_ACTION] };
    setApplied(filters);
    void search(filters);
  }

  function toggleAction(action: string): void {
    setForm(current => {
      if (current.actions.includes(action)) {
        return { ...current, actions: current.actions.filter(item => item !== action) };
      }
      if (current.actions.length >= MAX_ACTIONS) return current;
      return { ...current, actions: [...current.actions, action] };
    });
  }

  function closeSelected(): void {
    const id = selected?.id;
    setSelected(null);
    if (id) rowRefs.current.get(id)?.focus();
  }

  useEffect(() => {
    let active = true;
    void getAuditCatalog().then(
      result => { if (active) setCatalog(result); },
      () => { if (active) setCatalogError(true); },
    );
    void search({ actions: [], excludeActions: [READ_RECEIPTS_ACTION] });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="space-y-4 [color-scheme:dark]">
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
      {role === 'tenant_auditor'
        ? 'Read-only auditor access. Each search you run here is itself recorded in the audit trail.'
        : 'Each search you run here is itself recorded in the audit trail.'}
    </div>

    <nav aria-label="Audit sections" className="grid gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-2 sm:grid-cols-3">
      {AUDIT_TABS.map(item => <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`rounded-lg px-3 py-3 text-left transition ${tab === item.id ? 'bg-violet-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}><span className="block text-sm font-medium">{item.label}</span><span className={`mt-1 block text-xs ${tab === item.id ? 'text-violet-100' : 'text-slate-500'}`}>{item.description}</span></button>)}
    </nav>

    <div className={tab === 'trail' ? 'space-y-4' : 'hidden'} aria-hidden={tab !== 'trail'}>
    <form
      onSubmit={event => { event.preventDefault(); submitSearch(); }}
      className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-slate-400">From
          <input type="datetime-local" value={form.from} onChange={event => setForm({ ...form, from: event.target.value })} aria-label="From" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
        </label>
        <label className="block text-xs text-slate-400">To
          <input type="datetime-local" value={form.to} onChange={event => setForm({ ...form, to: event.target.value })} aria-label="To" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
        </label>
      </div>

      <fieldset>
        <legend className="text-xs text-slate-400">Severity</legend>
        <div className="mt-1 flex rounded-lg border border-slate-700 bg-slate-950 p-1">
          {(['', 'high', 'notice', 'info'] as const).map(value => (
            <button
              key={value || 'all'}
              type="button"
              onClick={() => setForm({ ...form, severity: value })}
              className={`rounded-md px-3 py-1.5 text-xs capitalize ${form.severity === value ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {value === '' ? 'All' : value}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-xs text-slate-400">Actions <span className="text-slate-600">({form.actions.length} of {MAX_ACTIONS})</span></legend>
        <div className="mt-1 max-h-56 space-y-3 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 p-3">
          {catalogError && <div className="text-xs text-amber-300">The action list is unavailable. You can still search with the other filters.</div>}
          {!catalog && !catalogError && <div className="text-xs text-slate-500">Loading actions…</div>}
          {emittedByOwner.map(group => (
            <div key={group.owner}>
              <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{group.owner}</div>
              <div className="mt-1 space-y-1">
                {group.actions.map(action => {
                  const checked = form.actions.includes(action);
                  const disabled = !checked && form.actions.length >= MAX_ACTIONS;
                  return (
                    <label key={action} className={`flex items-center gap-2 text-sm ${disabled ? 'text-slate-600' : 'text-slate-300'}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleAction(action)}
                        className="rounded border-slate-700"
                      />
                      <span className="font-mono text-xs">{action}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-slate-400">Actor
          <select value={form.actorType} onChange={event => setForm({ ...form, actorType: event.target.value })} aria-label="Actor type" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
            <option value="">Any</option>
            {ACTOR_TYPES.map(type => <option key={type} value={type}>{actorLabel(type)}</option>)}
          </select>
        </label>
        <label className="block text-xs text-slate-400">Actor id
          <input value={form.actorId} onChange={event => setForm({ ...form, actorId: event.target.value })} placeholder="Actor id" aria-label="Actor id" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-slate-400">Target
          <select value={form.targetType} onChange={event => setForm({ ...form, targetType: event.target.value })} aria-label="Target type" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
            <option value="">Any</option>
            {targetTypes.map(type => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label className="block text-xs text-slate-400">Target id
          <input value={form.targetId} onChange={event => setForm({ ...form, targetId: event.target.value })} placeholder="Target id" aria-label="Target id" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
        </label>
      </div>

      {formError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{formError}</div>}

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={form.showReadReceipts}
            onChange={event => setForm({ ...form, showReadReceipts: event.target.checked })}
            className="rounded border-slate-700"
          />
          Show read receipts
        </label>
        <p className="text-xs text-slate-500">Read receipts (each search recorded in this trail) are hidden. They are still recorded.</p>
      </div>

      <div className="flex gap-2">
        <button disabled={loading} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{loading ? 'Searching…' : 'Search'}</button>
        <button type="button" onClick={reset} disabled={loading} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 disabled:opacity-50">Reset</button>
      </div>
    </form>

    {notice && <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">{notice}</div>}

    {loading && (
      <div className="space-y-2" aria-label="Loading audit events">
        {[0, 1, 2].map(index => <div key={index} className="animate-pulse rounded-xl border border-slate-800 bg-slate-900/60 p-5"><div className="h-4 w-2/3 rounded bg-slate-800" /><div className="mt-2 h-4 w-1/3 rounded bg-slate-800" /></div>)}
      </div>
    )}

    {!loading && error && (
      <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-5 text-sm text-rose-200">
        <div>{error.message}</div>
        {error.requestId && <div className="mt-1 text-xs text-rose-200/70">Reference: {error.requestId}</div>}
      </div>
    )}

    {!loading && !error && events.length === 0 && (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-sm text-slate-500">No audit events match these filters.</div>
    )}

    {!loading && !error && events.length > 0 && (
      <div className="space-y-3">
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 bg-slate-950/50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Time</th>
                  <th className="px-5 py-3 font-medium">Severity</th>
                  <th className="px-5 py-3 font-medium">Action</th>
                  <th className="px-5 py-3 font-medium">Actor</th>
                  <th className="px-5 py-3 font-medium">Target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {events.map(event => (
                  <tr
                    key={event.id}
                    ref={row => {
                      if (row) rowRefs.current.set(event.id, row);
                      else rowRefs.current.delete(event.id);
                    }}
                    tabIndex={0}
                    onClick={() => setSelected(event)}
                    onKeyDown={e => { if (e.key === 'Enter') setSelected(event); }}
                    className="cursor-pointer hover:bg-slate-800/40"
                  >
                    <td className="px-5 py-4 text-slate-400" title={event.occurred_at}>{localTime(event.occurred_at)}</td>
                    <td className="px-5 py-4"><Badge tone={severityTone(event.severity)}>{event.severity}</Badge></td>
                    <td className="px-5 py-4 font-mono text-xs text-white">{event.action}</td>
                    <td className="px-5 py-4 text-slate-400" title={event.actor_id}>{actorLabel(event.actor_type)} · <span className="font-mono text-xs">{truncateId(event.actor_id)}</span></td>
                    <td className="px-5 py-4 text-slate-400" title={event.target_id}>{event.target_type} · <span className="font-mono text-xs">{truncateId(event.target_id)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="text-xs text-slate-600">{catalogVersion !== null && `Catalog version ${catalogVersion}`}</div>
          {cursor && <button onClick={() => void loadMore()} disabled={loadingMore} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 disabled:opacity-50">{loadingMore ? 'Loading…' : 'Load more'}</button>}
        </div>
      </div>
    )}
    {selected && (
      <EventDrawer
        event={selected}
        owner={catalog?.actions.find(entry => entry.action === selected.action)?.owner ?? 'Unknown'}
        onClose={closeSelected}
      />
    )}
    </div>
    <AuditEvidenceSection active={tab === 'evidence'} />
    <div className={tab === 'attestation' ? '' : 'hidden'} aria-hidden={tab !== 'attestation'}>
      <AttestaWorkspace repositories={repositories} />
    </div>
  </div>;
}
