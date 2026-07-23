'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import {
  getCommit, getCommits, getContributors, getDashboardSummary,
  getLifecycle,
  getPullRequestIntelligence, getPullRequests, getRepositories, getSession,
  getSessions, type CommitListItem, type Contributor, type DashboardSummary,
  type LifecycleResponse, type PullRequest, type Repository, type SessionListItem,
} from '@/lib/api';

type View = 'lifecycle' | 'sessions' | 'commits' | 'pullRequests' | 'repositories' | 'contributors';
type Detail = { kind: 'session' | 'commit' | 'pullRequest'; data: Record<string, any> } | null;

const navigation: Array<{ id: View; label: string }> = [
  { id: 'lifecycle', label: 'Code Lifecycle' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'commits', label: 'Commits' },
  { id: 'pullRequests', label: 'Pull Requests' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'contributors', label: 'Contributors' },
];

function compact(value: number | null) {
  return value === null ? 'Unavailable' : new Intl.NumberFormat('en', { notation: 'compact' }).format(value);
}

function date(value: string | null) {
  return value ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Unavailable';
}

function Badge({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'green' | 'amber' | 'violet' }) {
  const styles = { slate: 'bg-slate-800 text-slate-300', green: 'bg-emerald-500/10 text-emerald-300', amber: 'bg-amber-500/10 text-amber-300', violet: 'bg-violet-500/10 text-violet-300' };
  return <span className={`rounded-full px-2.5 py-1 text-xs ${styles[tone]}`}>{children}</span>;
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div className="text-xs uppercase tracking-wider text-slate-500">{label}</div><div className="mt-2 text-xl font-semibold text-white">{value}</div></div>;
}

function TableShell({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-slate-800 bg-slate-950/50 text-xs uppercase tracking-wider text-slate-500"><tr>{headers.map((header) => <th key={header} className="px-5 py-3 font-medium">{header}</th>)}</tr></thead><tbody className="divide-y divide-slate-800">{children}</tbody></table></div></div>;
}

function ratio(value: number | null) {
  return value === null ? 'Unavailable' : `${value.toFixed(value >= 10 ? 0 : 1)}:1`;
}

function LifecycleFlow({ data }: { data: LifecycleResponse | null }) {
  const summary = data?.summary;
  const stages = [
    ['Generated', summary?.generated],
    ['Committed', summary?.committed],
    ['In current PRs', summary?.inPullRequests],
    ['Merged', summary?.merged],
    ['Production', summary?.production],
  ] as const;
  const maximum = Math.max(1, ...stages.map(([, value]) => value?.value ?? 0));
  return <div className="space-y-6">
    <div className="grid grid-cols-4 gap-3">
      <Metric label="Generated : Committed" value={ratio(summary?.ratios.generatedToCommitted ?? null)} />
      <Metric label="Generated : PR" value={ratio(summary?.ratios.generatedToPullRequest ?? null)} />
      <Metric label="Generated : Merged" value={ratio(summary?.ratios.generatedToMerged ?? null)} />
      <Metric label="Generated : Production" value={ratio(summary?.ratios.generatedToProduction ?? null)} />
    </div>
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
      <div className="flex items-center justify-between"><div><h2 className="font-semibold text-white">Code lifecycle</h2><p className="mt-1 text-sm text-slate-500">Gross generation flowing toward customer production</p></div><Badge tone="violet">Evidence-aware</Badge></div>
      <div className="mt-7 grid grid-cols-5 gap-4">
        {stages.map(([label, value], index) => <div key={label} className="relative">
          <div className="flex h-64 items-end rounded-lg border border-slate-800 bg-slate-950/70 p-2">
            <div className="w-full rounded-md bg-gradient-to-t from-violet-600 to-cyan-400 transition-all" style={{ height: `${Math.max(value?.value ? 8 : 2, ((value?.value ?? 0) / maximum) * 100)}%` }} />
          </div>
          {index < stages.length - 1 && <div className="absolute -right-4 top-1/2 z-10 text-lg text-slate-600">→</div>}
          <div className="mt-3 text-sm font-medium text-slate-300">{label}</div>
          <div className="mt-1 text-2xl font-semibold text-white">{compact(value?.value ?? null)}</div>
          <div className="mt-1 text-xs text-slate-600">{value?.evidenceTypes.join(', ') || 'No evidence'}</div>
        </div>)}
      </div>
      {summary?.production.availability !== 'recorded' && summary?.mergedProxy.availability === 'recorded' && <div className="mt-6 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-200">Production is unavailable. {compact(summary.mergedProxy.value)} AI lines are merged to the default branch and shown only as a proxy.</div>}
      <div className="mt-6 grid grid-cols-2 gap-3"><Metric label="Reworked" value={compact(summary?.reworked.value ?? null)} /><Metric label="Production churn" value={compact(summary?.churned.value ?? null)} /></div>
    </div>
  </div>;
}

function DetailDrawer({ detail, close, openLinked }: { detail: Detail; close: () => void; openLinked: (kind: 'session' | 'commit', id: string) => void }) {
  if (!detail) return null;
  const data = detail.data;
  const usage = Array.isArray(data.usage) ? data.usage : [];
  const tokenTotal = usage.reduce((sum: number, row: any) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + (row.reasoningTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0), 0);
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={close}>
    <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-slate-800 bg-slate-950 p-7 shadow-2xl" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><div className="text-xs uppercase tracking-[0.2em] text-violet-400">{detail.kind} intelligence</div><h2 className="mt-2 text-2xl font-semibold text-white">{data.displayName ?? data.subject ?? data.pullRequest?.title ?? 'Details'}</h2></div><button onClick={close} className="rounded-lg border border-slate-700 px-3 py-2 text-slate-300">Close</button></div>
      <div className="mt-6 grid grid-cols-2 gap-3">
        {detail.kind === 'session' && <><Metric label="External session" value={<span className="text-sm">{data.externalSessionId}</span>} /><Metric label="Git AI correlation" value={<span className="text-sm">{data.gitAiSessionId ?? 'Unavailable'}</span>} /><Metric label="Final AI LoC" value={data.finalAiLines ?? 0} /><Metric label="Total tokens" value={compact(usage.length ? tokenTotal : null)} /></>}
        {detail.kind === 'commit' && <><Metric label="Commit" value={<span className="text-sm">{data.sha?.slice(0, 12)}</span>} /><Metric label="Branch" value={data.branch ?? 'Unavailable'} /><Metric label="Final AI attribution" value={data.finalAiLines?.auditedValue ?? 0} /><Metric label="Human attribution" value={data.finalHumanLines?.auditedValue ?? 0} /></>}
        {detail.kind === 'pullRequest' && <><Metric label="Commits" value={data.commits?.length ?? 0} /><Metric label="Sessions" value={data.sessions?.length ?? 0} /><Metric label="Final AI attribution" value={data.finalAiLines ?? 0} /><Metric label="Human attribution" value={data.finalHumanLines ?? 0} /></>}
      </div>
      {detail.kind !== 'pullRequest' && <div className={`mt-6 rounded-xl border p-4 text-sm ${data.totalAiGeneratedLoc?.status === 'recorded' ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200' : 'border-amber-500/20 bg-amber-500/5 text-amber-200'}`}><strong>Total AI Generated LoC:</strong> {compact(data.totalAiGeneratedLoc?.value ?? null)}. {data.totalAiGeneratedLoc?.reason ?? 'Derived from eligible checkpoint evidence.'}</div>}
      {usage.length > 0 && <section className="mt-7"><h3 className="mb-3 font-semibold text-white">Usage evidence</h3><div className="space-y-2">{usage.map((row: any) => <div key={row.id} className="rounded-lg border border-slate-800 p-4 text-sm text-slate-300"><div className="flex justify-between"><span>{row.model ?? 'Unknown model'}</span><Badge tone={row.availability === 'recorded' ? 'green' : 'amber'}>{row.availability}</Badge></div><div className="mt-2 text-slate-500">Input {compact(row.inputTokens)} · Output {compact(row.outputTokens)} · Cache {compact(row.cacheReadTokens)} · {row.costAmount ?? '—'} {row.costUnit ?? ''}</div><div className="mt-1 text-xs text-slate-600">Evidence: {row.evidenceSource}</div></div>)}</div></section>}
      {Array.isArray(data.commits) && <section className="mt-7"><h3 className="mb-3 font-semibold text-white">Commits</h3><div className="space-y-2">{data.commits.map((row: any) => <button key={row.id} onClick={() => openLinked('commit', row.id)} className="block w-full rounded-lg border border-slate-800 p-3 text-left text-sm text-slate-300 hover:border-violet-500/50"><span className="font-mono text-violet-300">{row.sha?.slice(0, 8)}</span> {row.subject}</button>)}</div></section>}
      {Array.isArray(data.sessions) && <section className="mt-7"><h3 className="mb-3 font-semibold text-white">Sessions</h3><div className="space-y-2">{data.sessions.map((row: any) => <button key={row.id} onClick={() => openLinked('session', row.id)} className="block w-full rounded-lg border border-slate-800 p-3 text-left text-sm text-slate-300 hover:border-violet-500/50">{row.externalSessionId} · {row.agent}</button>)}</div></section>}
      {detail.kind === 'session' && <section className="mt-7"><h3 className="font-semibold text-white">Deferred raw analytics</h3><div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-500">{['Traces', 'Checkpoints', 'Tool calls', 'Prompts'].map((label) => <div key={label} className="rounded-lg border border-dashed border-slate-800 p-3">{label}: Task2</div>)}</div></section>}
    </aside>
  </div>;
}

export default function DashboardPage() {
  const router = useRouter();
  const [view, setView] = useState<View>('sessions');
  const [query, setQuery] = useState('');
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleResponse | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [pullRequests, setPullRequests] = useState<PullRequest[]>([]);
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [commits, setCommits] = useState<CommitListItem[]>([]);
  const [detail, setDetail] = useState<Detail>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = useCallback(async (initial = false) => {
    try {
      if (initial) setLoading(true);
      const [summaryData, repositoryData, pullRequestData, contributorData, sessionData, commitData, lifecycleData] = await Promise.all([
        getDashboardSummary(), getRepositories(), getPullRequests(), getContributors(), getSessions(), getCommits(), getLifecycle(),
      ]);
      setSummary(summaryData); setRepositories(repositoryData); setPullRequests(pullRequestData);
      setContributors(contributorData); setSessions(sessionData); setCommits(commitData);
      setLifecycle(lifecycleData);
      setLastUpdated(new Date()); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to load dashboard data.'); }
    finally { if (initial) setLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (!data.session) { router.replace('/login'); return; }
      setEmail(data.session.user.email ?? null);
      void refresh(true);
    });
    const interval = window.setInterval(() => { void refresh(false); }, 15_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [refresh, router]);

  const matches = (values: Array<string | null | undefined>) => values.some((value) => value?.toLowerCase().includes(query.toLowerCase()));
  const filteredSessions = useMemo(() => sessions.filter((row) => matches([row.externalSessionId, row.displayName, row.agent, ...row.models.auditedValue])), [sessions, query]);
  const filteredCommits = useMemo(() => commits.filter((row) => matches([row.sha, row.subject, row.authorEmail, row.repository?.name])), [commits, query]);

  async function openDetail(kind: 'session' | 'commit' | 'pullRequest', id: string) {
    const data = kind === 'session' ? await getSession(id) : kind === 'commit' ? await getCommit(id) : await getPullRequestIntelligence(id);
    setDetail({ kind, data });
  }

  async function signOut() { await supabase.auth.signOut(); router.replace('/login'); }

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">Loading tenant dashboard…</div>;

  return <div className="min-h-screen bg-slate-950 text-slate-200">
    <aside className="fixed inset-y-0 left-0 w-64 border-r border-slate-800 bg-slate-950 p-5">
      <div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500 font-bold text-white">T</div><div><div className="font-semibold text-white">TrackAI</div><div className="text-xs text-slate-500">Telemetry intelligence</div></div></div>
      <nav className="mt-10 space-y-1">{navigation.map((item) => <button key={item.id} onClick={() => setView(item.id)} className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm ${view === item.id ? 'bg-violet-500/15 text-violet-200' : 'text-slate-400 hover:bg-slate-900 hover:text-white'}`}><span>{item.label}</span><span className="text-xs text-slate-600">{item.id === 'lifecycle' ? 'Live' : item.id === 'sessions' ? sessions.length : item.id === 'commits' ? commits.length : item.id === 'pullRequests' ? pullRequests.length : item.id === 'repositories' ? repositories.length : contributors.length}</span></button>)}</nav>
      <div className="absolute bottom-5 left-5 right-5 border-t border-slate-800 pt-4"><div className="truncate text-xs text-slate-500">{email}</div><button onClick={signOut} className="mt-2 text-xs text-slate-400 hover:text-white">Sign out</button></div>
    </aside>
    <main className="ml-64 min-h-screen p-8">
      <header className="flex items-start justify-between gap-5"><div><div className="text-sm text-violet-400">{summary?.organizationName ?? 'Workspace'}</div><h1 className="mt-1 text-3xl font-semibold text-white">{navigation.find((row) => row.id === view)?.label}</h1><div className="mt-2 text-xs text-slate-600">Live protected API · refreshes every 15 seconds{lastUpdated ? ` · ${lastUpdated.toLocaleTimeString()}` : ''}</div></div><div className="flex gap-2"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter rows…" className="w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-violet-500"/><button onClick={() => void refresh(false)} className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:border-violet-500">Refresh</button></div></header>
      {error && <div className="mt-5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">{error}</div>}
      <div className="mt-7 grid grid-cols-4 gap-3"><Metric label="Sessions" value={summary?.sessions ?? 0}/><Metric label="Commits" value={summary?.commits ?? 0}/><Metric label="Final AI lines" value={summary?.finalAiLines ?? 0}/><Metric label="Human lines" value={summary?.finalHumanLines ?? 0}/></div>
      <section className="mt-7">
        {view === 'lifecycle' && <LifecycleFlow data={lifecycle} />}
        {view === 'sessions' && <TableShell headers={['Session', 'Agent / model', 'Repository', 'Commits', 'Tokens', 'Status']}>
          {filteredSessions.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '')).map((row) => <tr key={row.id} onClick={() => void openDetail('session', row.id)} className="cursor-pointer hover:bg-slate-800/40"><td className="px-5 py-4"><div className="font-medium text-white">{row.displayName ?? 'Unnamed session'}</div><div className="mt-1 font-mono text-xs text-slate-500">{row.externalSessionId}</div></td><td className="px-5 py-4"><div>{row.agent}</div><div className="text-xs text-slate-500">{row.models.auditedValue.join(', ') || 'Unknown'} {row.models.corrected && <Badge tone="violet">corrected</Badge>}</div></td><td className="px-5 py-4 text-slate-400">{row.repositories.map((repo) => repo.name).join(', ') || '—'}</td><td className="px-5 py-4">{row.commitCount}</td><td className="px-5 py-4">{compact(row.totalTokens)}</td><td className="px-5 py-4"><Badge tone={row.status === 'shipped' ? 'green' : 'amber'}>{row.status}</Badge></td></tr>)}</TableShell>}
        {view === 'commits' && <TableShell headers={['Commit', 'Repository', 'Author', 'Sessions', 'Final AI', 'Human']}>
          {filteredCommits.sort((a, b) => (b.committedAt ?? '').localeCompare(a.committedAt ?? '')).map((row) => <tr key={row.id} onClick={() => void openDetail('commit', row.id)} className="cursor-pointer hover:bg-slate-800/40"><td className="px-5 py-4"><div className="font-medium text-white">{row.subject}</div><div className="mt-1 font-mono text-xs text-violet-400">{row.sha.slice(0, 9)}</div></td><td className="px-5 py-4 text-slate-400">{row.repository?.name ?? '—'}</td><td className="px-5 py-4 text-slate-400">{row.authorEmail ?? row.authorName ?? '—'}</td><td className="px-5 py-4">{row.sessionCount}</td><td className="px-5 py-4">{row.finalAiLines.auditedValue} {row.finalAiLines.corrected && <Badge tone="violet">audited</Badge>}</td><td className="px-5 py-4">{row.finalHumanLines.auditedValue}</td></tr>)}</TableShell>}
        {view === 'pullRequests' && <TableShell headers={['Pull request', 'Repository', 'Author', 'Branch', 'State', 'Updated']}>
          {pullRequests.filter((row) => matches([row.title, row.authorEmail, row.authorLogin, row.headRef])).map((row) => <tr key={row.id} onClick={() => void openDetail('pullRequest', row.id)} className="cursor-pointer hover:bg-slate-800/40"><td className="px-5 py-4 font-medium text-white">{row.title}</td><td className="px-5 py-4 text-slate-400">{repositories.find((repo) => repo.id === row.repositoryId)?.name ?? '—'}</td><td className="px-5 py-4 text-slate-400">{row.authorLogin ?? row.authorEmail ?? '—'}</td><td className="px-5 py-4">{row.headRef ?? '—'}</td><td className="px-5 py-4"><Badge tone={row.state === 'open' ? 'green' : 'slate'}>{row.state}</Badge></td><td className="px-5 py-4 text-slate-500">{date(row.updatedAt)}</td></tr>)}</TableShell>}
        {view === 'repositories' && <TableShell headers={['Repository', 'Provider', 'Canonical URL', 'External ID']}>
          {repositories.filter((row) => matches([row.name, row.url, row.provider])).map((row) => <tr key={row.id}><td className="px-5 py-4 font-medium text-white">{row.name}</td><td className="px-5 py-4">{row.provider}</td><td className="px-5 py-4 text-slate-400"><a href={row.url} target="_blank" rel="noreferrer" className="hover:text-violet-300">{row.normalizedUrl ?? row.url}</a></td><td className="px-5 py-4 text-slate-500">{row.externalId}</td></tr>)}</TableShell>}
        {view === 'contributors' && <TableShell headers={['Contributor', 'Email', 'Repository', 'Machine']}>
          {contributors.filter((row) => matches([row.name, row.email])).map((row) => <tr key={row.id}><td className="px-5 py-4 font-medium text-white">{row.name}</td><td className="px-5 py-4 text-slate-400">{row.email ?? 'Not provided by GitHub'}</td><td className="px-5 py-4">{repositories.find((repo) => repo.id === row.repositoryId)?.name ?? '—'}</td><td className="px-5 py-4 text-slate-500">{row.machineId ?? '—'}</td></tr>)}</TableShell>}
      </section>
    </main>
    <DetailDrawer detail={detail} close={() => setDetail(null)} openLinked={(kind, id) => void openDetail(kind, id)} />
  </div>;
}
