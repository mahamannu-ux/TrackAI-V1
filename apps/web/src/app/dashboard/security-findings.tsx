'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiProblemError,
  getSecurityFinding,
  getSecurityFindings,
  type Repository,
  type SecurityFindingDetail,
  type SecurityFindingItem,
  type SecurityFindingsQuery,
} from '@/lib/api';

type Problem = { message: string; requestId: string | null };
type Period = '7' | '30' | '90' | 'custom';
type Generation = NonNullable<SecurityFindingsQuery['generation']>;

const SECURITY_PROBLEM_MESSAGES: Record<string, string> = {
  SECURITY_READ_INVALID_QUERY: 'Review the findings filters; one or more values are invalid.',
  SECURITY_READ_FORBIDDEN: 'Your account does not have access to security data.',
  SECURITY_READ_NOT_FOUND: 'This finding is no longer available.',
  SECURITY_READ_UNAVAILABLE: 'Security data is temporarily unavailable.',
};

function describeProblem(cause: unknown, fallback: string): Problem {
  if (cause instanceof ApiProblemError) {
    return { message: (cause.code && SECURITY_PROBLEM_MESSAGES[cause.code]) || fallback, requestId: cause.requestId };
  }
  return { message: cause instanceof Error ? cause.message : fallback, requestId: null };
}

function displayDate(value: string | null | undefined): string {
  if (!value) return 'Not reported';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? 'Not reported'
    : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

function readable(value: string | null | undefined): string {
  if (value === 'unreported') return 'Not reported';
  if (value === 'no_lease') return 'No lease';
  if (value === 'not_acknowledged') return 'Not acknowledged';
  return value ? value.replaceAll('_', ' ').replaceAll('-', ' ') : 'Not reported';
}

function localInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function toIso(value: string): string | null {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function Badge({ children, tone = 'slate' }: {
  children: React.ReactNode;
  tone?: 'slate' | 'green' | 'amber' | 'rose' | 'violet';
}) {
  const styles = {
    slate: 'border-slate-700 bg-slate-800 text-slate-300',
    green: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
    amber: 'border-amber-500/20 bg-amber-500/10 text-amber-200',
    rose: 'border-rose-500/20 bg-rose-500/10 text-rose-200',
    violet: 'border-violet-500/20 bg-violet-500/10 text-violet-200',
  };
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs ${styles[tone]}`}>{children}</span>;
}

function ProblemMessage({ problem }: { problem: Problem | null }) {
  if (!problem) return null;
  return <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
    <p>{problem.message}</p>
    {problem.requestId && <p className="mt-1 text-xs text-rose-200/60">Request ID: {problem.requestId}</p>}
  </div>;
}

function loadingMessage() {
  return <p className="py-10 text-center text-sm text-slate-500">Loading security data…</p>;
}

function InfoCard({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
    <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
    <div className="mt-1 break-words text-sm text-slate-200">{value}</div>
  </div>;
}

function findingRepository(item: SecurityFindingItem, repositories: Repository[]): string {
  if (item.repository_kind === 'not_enrolled') return 'Machine-wide (not enrolled)';
  if (!item.repository_id) return 'Not reported';
  return repositories.find(repository => repository.id === item.repository_id)?.name ?? item.repository_id;
}

function findingPhase(phase: string | null): string {
  if (!phase) return 'Not reported';
  if (phase === 'requested') return 'Requested';
  if (phase === 'observed_result' || phase === 'observed-result' || phase === 'observed result') return 'Observed result';
  return readable(phase);
}

function enforcementDecision(value: string): string {
  if (value === 'deny') return 'Denied by request';
  if (value === 'no_override') return 'No denial requested';
  return value;
}

export function FindingsTab({ repositories }: { repositories: Repository[] }) {
  const [items, setItems] = useState<SecurityFindingItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listProblem, setListProblem] = useState<Problem | null>(null);
  const [filtersProblem, setFiltersProblem] = useState<string | null>(null);
  const [detail, setDetail] = useState<SecurityFindingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailProblem, setDetailProblem] = useState<Problem | null>(null);
  const detailRequest = useRef(0);
  const [period, setPeriod] = useState<Period>('30');
  const [customFrom, setCustomFrom] = useState(() => localInputValue(new Date(Date.now() - 30 * 86_400_000)));
  const [customTo, setCustomTo] = useState(() => localInputValue(new Date()));
  const [severity, setSeverity] = useState('');
  const [category, setCategory] = useState('');
  const [ruleId, setRuleId] = useState('');
  const [agent, setAgent] = useState('');
  const [machineId, setMachineId] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [generation, setGeneration] = useState<Generation | ''>('');
  const [activeQuery, setActiveQuery] = useState<SecurityFindingsQuery>({ limit: 50 });

  const load = useCallback(async (query: SecurityFindingsQuery, append: boolean) => {
    setLoading(true);
    setListProblem(null);
    try {
      const page = await getSecurityFindings(query);
      setItems(previous => append ? [...previous, ...page.items] : page.items);
      setNextCursor(page.next_cursor);
      setActiveQuery(query);
    } catch (cause) {
      setListProblem(describeProblem(cause, 'Findings could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load({ limit: 50 }, false);
  }, [load]);

  async function openFinding(id: string) {
    const request = ++detailRequest.current;
    setDetail(null);
    setDetailProblem(null);
    setDetailLoading(true);
    try {
      const result = await getSecurityFinding(id);
      if (detailRequest.current === request) setDetail(result);
    } catch (cause) {
      if (detailRequest.current === request) setDetailProblem(describeProblem(cause, 'Finding details could not be loaded.'));
    } finally {
      if (detailRequest.current === request) setDetailLoading(false);
    }
  }

  function closeDetail() {
    detailRequest.current += 1;
    setDetail(null);
    setDetailLoading(false);
    setDetailProblem(null);
  }

  function applyFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const now = new Date();
    const to = period === 'custom' ? toIso(customTo) : now.toISOString();
    const from = period === 'custom'
      ? toIso(customFrom)
      : new Date(now.getTime() - Number(period) * 86_400_000).toISOString();
    if (!from || !to || new Date(from).getTime() >= new Date(to).getTime()) {
      setFiltersProblem('Choose a valid start and end time, with the start before the end.');
      return;
    }
    const query: SecurityFindingsQuery = {
      limit: 50,
      from,
      to,
      ...(severity ? { severity } : {}),
      ...(category ? { category } : {}),
      ...(ruleId ? { rule_id: ruleId } : {}),
      ...(agent ? { agent } : {}),
      ...(machineId ? { machine_id: machineId } : {}),
      ...(repositoryId ? { repository_id: repositoryId } : {}),
      ...(generation ? { generation } : {}),
    };
    setFiltersProblem(null);
    void load(query, false);
  }

  return <div className="space-y-5">
    <form onSubmit={applyFilters} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
        <label className="space-y-1 text-xs text-slate-400">Period
          <select value={period} onChange={event => setPeriod(event.target.value as Period)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200">
            <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom</option>
          </select>
        </label>
        {period === 'custom' && <>
          <label className="space-y-1 text-xs text-slate-400">From
            <input type="datetime-local" value={customFrom} onChange={event => setCustomFrom(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
          </label>
          <label className="space-y-1 text-xs text-slate-400">To
            <input type="datetime-local" value={customTo} onChange={event => setCustomTo(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
          </label>
        </>}
        <label className="space-y-1 text-xs text-slate-400">Severity
          <select value={severity} onChange={event => setSeverity(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200">
            <option value="">All severities</option>{['critical', 'high', 'medium', 'low', 'info'].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs text-slate-400">Category
          <input value={category} onChange={event => setCategory(event.target.value)} placeholder="All categories" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
        </label>
        <label className="space-y-1 text-xs text-slate-400">Rule
          <input value={ruleId} onChange={event => setRuleId(event.target.value)} placeholder="All rules" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
        </label>
        <label className="space-y-1 text-xs text-slate-400">Agent
          <input value={agent} onChange={event => setAgent(event.target.value)} placeholder="All agents" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
        </label>
        <label className="space-y-1 text-xs text-slate-400">Machine
          <input value={machineId} onChange={event => setMachineId(event.target.value)} placeholder="All machines" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200" />
        </label>
        <label className="space-y-1 text-xs text-slate-400">Repository
          <select value={repositoryId} onChange={event => setRepositoryId(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200">
            <option value="">All repositories</option>
            {repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.name}</option>)}
            <option value="not_enrolled">Machine-wide (not enrolled)</option>
          </select>
        </label>
        <label className="space-y-1 text-xs text-slate-400">Generation
          <select value={generation} onChange={event => {
            const value = event.target.value;
            setGeneration(value === 'v2' || value === 'task6a' ? value : '');
          }} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200">
            <option value="">All generations</option><option value="v2">Current format</option><option value="task6a">Older format</option>
          </select>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={loading} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">Apply filters</button>
        {filtersProblem && <p role="alert" className="text-sm text-rose-200">{filtersProblem}</p>}
      </div>
    </form>

    <ProblemMessage problem={listProblem} />
    {loading && items.length === 0 ? loadingMessage() : <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1050px] text-left text-sm">
          <thead className="border-b border-slate-800 bg-slate-950/50 text-xs uppercase tracking-wider text-slate-500"><tr>
            {['Time', 'Severity', 'Rule', 'Agent', 'Model', 'Repository', 'Machine'].map(label => <th key={label} className="px-4 py-3 font-medium">{label}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-800">
            {items.map(item => <tr key={`${item.generation}-${item.id}`} className="hover:bg-slate-800/40">
              <td className="whitespace-nowrap px-4 py-3 text-slate-400">{displayDate(item.occurred_at)}</td>
              <td className="px-4 py-3"><Badge tone={item.rule_severity === 'critical' || item.rule_severity === 'high' ? 'rose' : item.rule_severity === 'medium' ? 'amber' : 'slate'}>{readable(item.rule_severity)}</Badge></td>
              <td className="max-w-xs px-4 py-3">
                <button type="button" onClick={() => void openFinding(item.id)} className="text-left text-violet-200 hover:text-violet-100">{item.rule_id}</button>
                <div className="mt-1 truncate text-xs text-slate-500">{item.title ?? 'Title not reported'}</div>
                {item.generation === 'task6a' && <div className="mt-1 flex flex-wrap items-center gap-2"><Badge>Older format</Badge><span className="text-xs text-slate-500">{findingPhase(item.phase)}</span></div>}
              </td>
              <td className="px-4 py-3 text-slate-300">{readable(item.agent)}</td>
              <td className="px-4 py-3 text-slate-400">{item.model ?? 'Not reported'}</td>
              <td className="px-4 py-3 text-slate-300">{findingRepository(item, repositories)}</td>
              <td className="px-4 py-3 font-mono text-xs text-slate-400">{item.machine_id}</td>
            </tr>)}
            {!loading && items.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">No findings match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      {nextCursor && <div className="border-t border-slate-800 p-4 text-center">
        <button type="button" disabled={loading} onClick={() => void load({ ...activeQuery, cursor: nextCursor }, true)} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-violet-500 disabled:opacity-50">Load more</button>
      </div>}
    </div>}

    {(detailLoading || detailProblem || detail) && <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/70" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeDetail(); }}>
      <aside role="dialog" aria-modal="true" aria-label="Finding details" className="h-full w-full max-w-2xl overflow-y-auto border-l border-slate-800 bg-slate-950 p-6 shadow-2xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div><p className="text-xs uppercase tracking-wider text-violet-300">Finding details</p><h2 className="mt-1 text-xl font-semibold text-white">{detail?.finding.title ?? detail?.finding.rule_id ?? 'Finding'}</h2></div>
          <button type="button" onClick={closeDetail} className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-violet-500">Close</button>
        </div>
        {detailLoading && loadingMessage()}
        <ProblemMessage problem={detailProblem} />
        {detail && <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <InfoCard label="Rule" value={`${detail.finding.rule_id} · ${detail.finding.title ?? 'Title not reported'}`} />
            <InfoCard label="Severity" value={readable(detail.finding.rule_severity)} />
            <InfoCard label="Category" value={readable(detail.finding.rule_category)} />
            <InfoCard label="Generation" value={detail.finding.generation === 'task6a' ? 'Older format' : 'Current format'} />
            <InfoCard label="Agent" value={readable(detail.finding.agent)} />
            <InfoCard label="Model" value={detail.finding.model ?? 'Not reported'} />
            <InfoCard label="Repository" value={findingRepository(detail.finding, repositories)} />
            <InfoCard label="Machine" value={detail.finding.machine_id} />
            <InfoCard label="Occurred" value={displayDate(detail.finding.occurred_at)} />
            <InfoCard label="Received" value={displayDate(detail.finding.received_at)} />
            {detail.finding.generation === 'task6a' && <InfoCard label="Phase" value={findingPhase(detail.finding.phase)} />}
            {detail.finding.result_category && <InfoCard label="Observed result" value={readable(detail.finding.result_category)} />}
          </div>
          <section>
            <h3 className="font-semibold text-white">Enforcement decisions nearby</h3>
            {detail.nearby_enforcement.length ? <ul className="mt-3 space-y-2">
              {detail.nearby_enforcement.map(decision => <li key={decision.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><Badge>{enforcementDecision(decision.decision)}</Badge><span className="text-xs text-slate-500">{displayDate(decision.occurred_at)}</span></div>
                <p className="mt-2 text-sm text-slate-300">Mode: {readable(decision.mode)} · Tool: {readable(decision.tool_name)}</p>
              </li>)}
            </ul> : <p className="mt-2 text-sm text-slate-500">No nearby enforcement decisions were returned.</p>}
          </section>
          <section>
            <h3 className="font-semibold text-white">Indicators seen nearby on this machine (not linked to this finding)</h3>
            {detail.machine_indicators_nearby.length ? <ul className="mt-3 space-y-2">
              {detail.machine_indicators_nearby.map((indicator, index) => <li key={`${indicator.type}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                <span className="text-sm text-slate-300">{readable(indicator.type)}</span>
                <span className="break-all text-sm text-slate-400">{indicator.value ?? 'Hidden (URL or email)'}</span>
                <span className="text-xs text-slate-500">Count: {indicator.count}</span>
              </li>)}
            </ul> : <p className="mt-2 text-sm text-slate-500">No nearby machine indicators were returned.</p>}
          </section>
        </div>}
      </aside>
    </div>}
  </div>;
}
