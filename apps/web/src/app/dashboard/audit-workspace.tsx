'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AuditApiError,
  getAuditCatalog,
  listAuditEvents,
  type AuditCatalog,
  type AuditEvent,
  type AuditFilters,
} from '@/lib/api';

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
  children: React.ReactNode; tone?: 'slate' | 'amber' | 'rose';
}) {
  const styles = {
    slate: 'bg-slate-800 text-slate-300',
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
};

function toFilters(form: FormState): AuditFilters {
  return {
    actions: [...form.actions],
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

export function AuditWorkspace({ role }: { role: 'tenant_admin' | 'tenant_auditor' }) {
  const [catalog, setCatalog] = useState<AuditCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [applied, setApplied] = useState<AuditFilters>({ actions: [] });
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [catalogVersion, setCatalogVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    const filters: AuditFilters = { actions: [] };
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

  useEffect(() => {
    let active = true;
    void getAuditCatalog().then(
      result => { if (active) setCatalog(result); },
      () => { if (active) setCatalogError(true); },
    );
    void search({ actions: [] });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="space-y-4 [color-scheme:dark]">
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
      {role === 'tenant_auditor'
        ? 'Read-only auditor access. Each search you run here is itself recorded in the audit trail.'
        : 'Each search you run here is itself recorded in the audit trail.'}
    </div>

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
                  <tr key={event.id}>
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
  </div>;
}
