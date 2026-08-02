'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import {
  getCommit, getCommitEvidenceFlow, getCommits, getContributors, getDashboardSummary,
  getLifecycle,
  getModels, getPullRequestIntelligence, getPullRequests, getRepositories, getSession,
  getSessions, getAdminContext, getAdminAudit, getAdminBackfillAuthorizations,
  getAdminGitHubInstallations, getAdminMachines, getAdminRepositoryPolicies,
  issueAdminMachineCredential, registerAdminMachine, revokeAdminMachine,
  revokeAdminMachineCredential,
  enrollAdminRepository, grantAdminMachineRepository,
  replaceAdminMachineRepositoryGrantBranchScope,
  revokeAdminMachineRepositoryGrant, revokeAdminRepositoryEnrollment,
  authorizeAdminRepositoryBackfill, revokeAdminRepositoryBackfill,
  type AdminAuditResources, type AdminBackfillResources, type AdminContext,
  type AdminGitHubResources, type AdminMachineResources, type AdminRepositoryResources,
  type CommitListItem, type Contributor, type DashboardSummary,
  type EvidenceFlowNode, type EvidenceFlowResponse, type LifecycleResponse,
  type PullRequest, type Repository, type SessionListItem, type TelemetryModel,
} from '@/lib/api';

type View = 'lifecycle' | 'sessions' | 'commits' | 'pullRequests' | 'repositories' | 'contributors' | 'administration';
type Detail = { kind: 'session' | 'commit' | 'pullRequest'; data: Record<string, any> } | null;

const navigation: Array<{ id: View; label: string }> = [
  { id: 'lifecycle', label: 'Code Lifecycle' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'commits', label: 'Commits' },
  { id: 'pullRequests', label: 'Pull Requests' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'contributors', label: 'Contributors' },
  { id: 'administration', label: 'Administration' },
];

function compact(value: number | null) {
  return value === null ? 'Unavailable' : new Intl.NumberFormat('en', { notation: 'compact' }).format(value);
}

function date(value: string | null) {
  return value ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Unavailable';
}

function localDateTimeValue(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
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

function lifecycleQuery(scopeKey: string) {
  if (scopeKey === 'tenant') return '';
  const separator = scopeKey.indexOf(':');
  const kind = scopeKey.slice(0, separator);
  const id = scopeKey.slice(separator + 1);
  const parameter = kind === 'repository'
    ? 'repositoryId'
    : kind === 'pullRequest'
      ? 'pullRequestId'
      : kind === 'model'
        ? 'modelKey'
        : 'contributorId';
  return `?${parameter}=${encodeURIComponent(id)}`;
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
          {value?.availability === 'partial' && <div className="mt-1 text-xs text-amber-300">Observed partial evidence: {compact(value.observedValue ?? null)}</div>}
          <div className="mt-1 text-xs text-slate-600">{value?.evidenceTypes.join(', ') || 'No evidence'}</div>
        </div>)}
      </div>
      {summary?.production.availability !== 'recorded' && summary?.mergedProxy.availability === 'recorded' && <div className="mt-6 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-200">Production is unavailable. {compact(summary.mergedProxy.value)} AI lines are merged to the default branch and shown only as a proxy.</div>}
      <div className="mt-6 grid grid-cols-2 gap-3"><Metric label="Reworked" value={compact(summary?.reworked.value ?? null)} /><Metric label="Production churn" value={compact(summary?.churned.value ?? null)} /></div>
    </div>
  </div>;
}

function EvidenceNode({ node }: { node: EvidenceFlowNode }) {
  const label = {
    developer_prompt: 'Developer prompt', agent_thinking: 'Agent thinking',
    agent_response: 'Agent response', tool_call: `Tool call · ${node.toolName ?? 'unknown'}`,
    tool_result: `Tool result · ${node.toolName ?? 'unknown'}`, commit: 'Commit',
  }[node.type];
  const detail = node.type === 'tool_call' ? node.arguments
    : node.type === 'tool_result' ? node.result : node.content;
  return <div className="border-l border-violet-500/30 pl-4"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium text-violet-200">{label}</span><span className="text-xs text-slate-600">{date(node.timestamp)}</span></div><div className="mt-1 text-xs text-slate-500">{node.model ?? 'No model'} · {node.linkageQuality}</div>{detail !== null && detail !== undefined && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs text-slate-300">{typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}</pre>}{node.availabilityReason && <div className="mt-2 text-xs text-amber-300">{node.availabilityReason}</div>}</div>;
}

function EvidenceFlow({ flow }: { flow: EvidenceFlowResponse }) {
  const rendered: React.ReactNode[] = [];
  for (let index = 0; index < flow.nodes.length;) {
    if (flow.nodes[index].type !== 'tool_call' && flow.nodes[index].type !== 'tool_result') {
      rendered.push(<EvidenceNode key={flow.nodes[index].id} node={flow.nodes[index]} />); index += 1; continue;
    }
    const group: EvidenceFlowNode[] = [];
    while (index < flow.nodes.length && (flow.nodes[index].type === 'tool_call' || flow.nodes[index].type === 'tool_result')) group.push(flow.nodes[index++]);
    const calls = group.filter((node) => node.type === 'tool_call').length;
    rendered.push(<details key={`tools:${group[0].id}`} className="rounded-lg border border-slate-800 p-3"><summary className="cursor-pointer text-sm text-cyan-200">{calls} tool {calls === 1 ? 'call' : 'calls'}</summary><div className="mt-4 space-y-4">{group.map((node) => <EvidenceNode key={node.id} node={node} />)}</div></details>);
  }
  return <div className="space-y-4">{rendered}</div>;
}

function DetailDrawer({ detail, close, openLinked }: { detail: Detail; close: () => void; openLinked: (kind: 'session' | 'commit', id: string) => void }) {
  const [evidence, setEvidence] = useState<EvidenceFlowResponse | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  useEffect(() => { setEvidence(null); setEvidenceError(null); }, [detail?.data?.id]);
  if (!detail) return null;
  const data = detail.data;
  const usage = Array.isArray(data.usage) ? data.usage : [];
  const tokenTotal = usage.reduce((sum: number, row: any) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + (row.reasoningTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0), 0);
  const generatedAiLoc = data.totalAiGeneratedLoc?.value ?? null;
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={close}>
    <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-slate-800 bg-slate-950 p-7 shadow-2xl" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-4"><div><div className="text-xs uppercase tracking-[0.2em] text-violet-400">{detail.kind} intelligence</div><h2 className="mt-2 text-2xl font-semibold text-white">{data.displayName ?? data.subject ?? data.pullRequest?.title ?? 'Details'}</h2></div><button onClick={close} className="rounded-lg border border-slate-700 px-3 py-2 text-slate-300">Close</button></div>
      <div className="mt-6 grid grid-cols-2 gap-3">
        {detail.kind === 'session' && <><Metric label="External session" value={<span className="text-sm">{data.externalSessionId}</span>} /><Metric label="Git AI correlation" value={<span className="text-sm">{data.gitAiSessionId ?? 'Unavailable'}</span>} /><Metric label="Generated AI LoC" value={compact(generatedAiLoc)} /><Metric label="Retained in commits" value={data.finalAiLines ?? 0} /><Metric label="Total tokens" value={compact(usage.length ? tokenTotal : null)} /></>}
        {detail.kind === 'commit' && <><Metric label="Commit" value={<span className="text-sm">{data.sha?.slice(0, 12)}</span>} /><Metric label="Branch" value={data.branch ?? 'Unavailable'} /><Metric label="Final AI attribution" value={data.finalAiLines?.auditedValue ?? 0} /><Metric label="Human attribution" value={data.finalHumanLines?.auditedValue ?? 0} /><Metric label="Diff added / deleted" value={`${data.diffAddedLines ?? 0} / ${data.diffDeletedLines ?? 0}`} /><Metric label="Reworked generated LoC" value={compact(data.rework?.value ?? null)} /><Metric label="Lifecycle" value={<span className="text-sm">{data.reachability ?? 'Observed'} · {data.operationKind ?? 'commit'}</span>} /><Metric label="Unknown attribution" value={data.unknownLines ?? 0} /></>}
        {detail.kind === 'pullRequest' && <><Metric label="Commits" value={data.commits?.length ?? 0} /><Metric label="Sessions" value={data.sessions?.length ?? 0} /><Metric label="Final AI attribution" value={data.finalAiLines ?? 0} /><Metric label="Human attribution" value={data.finalHumanLines ?? 0} /></>}
      </div>
      {detail.kind === 'session' && <div className={`mt-6 rounded-xl border p-4 text-sm ${data.totalAiGeneratedLoc?.status === 'recorded' ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200' : 'border-amber-500/20 bg-amber-500/5 text-amber-200'}`}><strong>Session lifecycle:</strong> {compact(generatedAiLoc)} AI lines generated; {data.finalAiLines ?? 0} currently retained in commits. Uncommitted generation remains valuable evidence but is not final commit attribution.</div>}
      {detail.kind === 'commit' && <div className={`mt-6 rounded-xl border p-4 text-sm ${data.totalAiGeneratedLoc?.status === 'recorded' ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200' : 'border-amber-500/20 bg-amber-500/5 text-amber-200'}`}><strong>AI Generated LoC:</strong> {compact(generatedAiLoc)}. {data.totalAiGeneratedLoc?.status === 'partial' && <>Observed partial evidence: {compact(data.totalAiGeneratedLoc?.observedValue ?? null)}. </>}{data.totalAiGeneratedLoc?.reason ?? 'Derived from eligible checkpoint evidence.'}</div>}
      {detail.kind === 'commit' && data.rework?.availability === 'recorded' && <div className="mt-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 text-sm text-cyan-200"><strong>Rework actors:</strong> {Object.entries(data.rework.byActor ?? {}).map(([actor, lines]) => `${actor} ${lines}`).join(' · ')}. Evidence: {data.rework.evidenceTypes?.join(', ') || 'Unavailable'}.</div>}
      {detail.kind === 'commit' && <section className="mt-7"><div className="flex items-center justify-between"><div><h3 className="font-semibold text-white">Evidence flow</h3><p className="mt-1 text-xs text-amber-300">Development-only local provider evidence</p></div>{!evidence && <button disabled={evidenceLoading} onClick={() => { setEvidenceLoading(true); setEvidenceError(null); void getCommitEvidenceFlow(data.id).then(setEvidence).catch((cause) => setEvidenceError(cause instanceof Error ? cause.message : 'Evidence unavailable')).finally(() => setEvidenceLoading(false)); }} className="rounded-lg border border-violet-500/40 px-3 py-2 text-sm text-violet-200 disabled:opacity-50">{evidenceLoading ? 'Loading…' : 'Load evidence'}</button>}</div>{evidenceError && <div className="mt-3 rounded-lg border border-amber-500/20 p-3 text-sm text-amber-200">{evidenceError}</div>}{evidence && <div className="mt-4">{evidence.status === 'recorded' ? <EvidenceFlow flow={evidence} /> : <div className="rounded-lg border border-slate-800 p-3 text-sm text-slate-400">{evidence.reason}</div>}</div>}</section>}
      {usage.length > 0 && <section className="mt-7"><h3 className="mb-3 font-semibold text-white">Usage evidence</h3><div className="space-y-2">{usage.map((row: any) => <div key={row.id} className="rounded-lg border border-slate-800 p-4 text-sm text-slate-300"><div className="flex justify-between"><span>{row.model ?? 'Unknown model'}</span><Badge tone={row.availability === 'recorded' ? 'green' : 'amber'}>{row.availability}</Badge></div><div className="mt-2 text-slate-500">Input {compact(row.inputTokens)} · Output {compact(row.outputTokens)} · Cache {compact(row.cacheReadTokens)} · {row.costAmount ?? '—'} {row.costUnit ?? ''}</div><div className="mt-1 text-xs text-slate-600">Evidence: {row.evidenceSource}</div></div>)}</div></section>}
      {detail.kind === 'pullRequest' && data.membership && <section className="mt-7"><h3 className="mb-3 font-semibold text-white">PR membership evidence</h3><div className="grid grid-cols-3 gap-3"><Metric label="Active commits" value={data.membership.current ?? 0} /><Metric label="Removed historical" value={data.membership.removedHistorical ?? 0} /><Metric label="Source" value={<span className="text-sm">{data.membership.source ?? 'Unavailable'}</span>} /></div></section>}
      {detail.kind === 'pullRequest' && data.mergeResult && <section className="mt-7"><h3 className="mb-3 font-semibold text-white">Merge result</h3><button onClick={() => openLinked('commit', data.mergeResult.id)} className="block w-full rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 text-left text-sm text-slate-300 hover:border-violet-400"><span className="font-mono text-violet-300">{data.mergeResult.sha?.slice(0, 12)}</span> {data.mergeResult.subject}<span className="ml-2 text-xs text-slate-500">{data.mergeResult.operationKind}</span></button></section>}
      {Array.isArray(data.commits) && <section className="mt-7"><h3 className="mb-3 font-semibold text-white">Commits</h3><div className="space-y-2">{data.commits.map((row: any) => <button key={row.id} onClick={() => openLinked('commit', row.id)} className="block w-full rounded-lg border border-slate-800 p-3 text-left text-sm text-slate-300 hover:border-violet-500/50"><span className="font-mono text-violet-300">{row.sha?.slice(0, 8)}</span> {row.subject}</button>)}</div></section>}
      {Array.isArray(data.sessions) && <section className="mt-7"><h3 className="mb-3 font-semibold text-white">Sessions</h3><div className="space-y-2">{data.sessions.map((row: any) => <button key={row.id} onClick={() => openLinked('session', row.id)} className="block w-full rounded-lg border border-slate-800 p-3 text-left text-sm text-slate-300 hover:border-violet-500/50">{row.externalSessionId} · {row.agent}</button>)}</div></section>}
      {detail.kind === 'session' && <section className="mt-7"><h3 className="font-semibold text-white">Deferred raw analytics</h3><div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-500">{['Traces', 'Checkpoints', 'Tool calls', 'Prompts'].map((label) => <div key={label} className="rounded-lg border border-dashed border-slate-800 p-3">{label}: Task2</div>)}</div></section>}
    </aside>
  </div>;
}

type AdminResources = {
  machines: AdminMachineResources | null;
  repositories: AdminRepositoryResources | null;
  backfills: AdminBackfillResources | null;
  github: AdminGitHubResources | null;
  audit: AdminAuditResources;
};

type AdminSection = 'overview' | 'machines' | 'repositories' | 'history' | 'github' | 'audit';

const adminNavigation: Array<{ id: AdminSection; label: string; description: string }> = [
  { id: 'overview', label: 'Overview', description: 'Setup status and next steps' },
  { id: 'machines', label: 'Machines & keys', description: 'Installations and credentials' },
  { id: 'repositories', label: 'Repository access', description: 'Enrollment, branches, and grants' },
  { id: 'history', label: 'Historical import', description: 'Allow selected older evidence' },
  { id: 'github', label: 'GitHub App', description: 'Connected organizations' },
  { id: 'audit', label: 'Security audit', description: 'Who changed what' },
];

function isTask4VerificationRepository(repository: Repository): boolean {
  return repository.name.startsWith('task4-wave4-matrix-');
}

function AdminPanel({ context, resources, loading, error, onChanged }: {
  context: AdminContext | null; resources: AdminResources | null; loading: boolean;
  error: string | null; onChanged: () => void;
}) {
  const active = context?.membership?.status === 'active';
  const [machineForm, setMachineForm] = useState({ installationId: '', displayName: '', platform: '' });
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [adminSection, setAdminSection] = useState<AdminSection>('overview');
  const [repositorySearch, setRepositorySearch] = useState('');
  const [repositoryStatus, setRepositoryStatus] = useState<'all' | 'active' | 'unenrolled'>('all');
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [branchScopeEdit, setBranchScopeEdit] = useState<null | {
    grantId: string;
    mode: 'all' | 'selected';
    patterns: string[];
    draft: string;
    reason: string;
  }>(null);
  const [branchScopeError, setBranchScopeError] = useState<string | null>(null);
  const [oneTimeCredential, setOneTimeCredential] = useState<{ keyId: string; plaintext: string } | null>(null);
  const [credentialCopied, setCredentialCopied] = useState(false);
  const credentialPanelRef = useRef<HTMLDivElement | null>(null);
  const [grantForm, setGrantForm] = useState({
    machineId: '', enrollmentId: '', branches: '', reason: '',
  });
  const [backfillForm, setBackfillForm] = useState<{
    enrollmentId: string;
    evidenceFamily: 'generation_session' | 'commit_note';
    occurredFrom: string;
    occurredUntil: string;
    expiresAt: string;
    reason: string;
  }>(() => ({
    enrollmentId: '', evidenceFamily: 'generation_session',
    occurredFrom: localDateTimeValue(new Date(Date.now() - 24 * 60 * 60 * 1_000)),
    occurredUntil: localDateTimeValue(new Date()),
    expiresAt: localDateTimeValue(new Date(Date.now() + 60 * 60 * 1_000)),
    reason: '',
  }));

  useEffect(() => {
    if (oneTimeCredential) {
      credentialPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [oneTimeCredential]);

  async function mutate(operation: () => Promise<unknown>): Promise<boolean> {
    setMutationBusy(true);
    setMutationError(null);
    try {
      await operation();
      onChanged();
      return true;
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : 'Administrative operation failed.');
      return false;
    } finally {
      setMutationBusy(false);
    }
  }

  async function registerMachine(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const succeeded = await mutate(() => registerAdminMachine({
      installationId: machineForm.installationId,
      displayName: machineForm.displayName,
      ...(machineForm.platform ? { platform: machineForm.platform } : {}),
    }));
    if (succeeded) setMachineForm({ installationId: '', displayName: '', platform: '' });
  }

  async function issueCredential(machineId: string, rotatedFromCredentialId?: string): Promise<void> {
    if (oneTimeCredential) {
      setMutationError('Dismiss the currently displayed one-time credential before issuing another.');
      return;
    }
    if (!window.confirm(rotatedFromCredentialId
      ? 'Stage a new credential for rotation? Its plaintext will be shown exactly once.'
      : 'Issue a machine credential? Its plaintext will be shown exactly once.')) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      const response = await issueAdminMachineCredential(machineId, rotatedFromCredentialId);
      setOneTimeCredential({ keyId: response.credential.keyId, plaintext: response.credential.plaintext });
      setCredentialCopied(false);
      onChanged();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : 'Credential issuance failed.');
    } finally {
      setMutationBusy(false);
    }
  }

  async function reasonedMutation(label: string, operation: (reason: string) => Promise<unknown>) {
    const reason = window.prompt(`${label}\n\nEnter an audit reason:`)?.trim();
    if (!reason) return;
    await mutate(() => operation(reason));
  }

  async function enroll(repositoryId: string): Promise<void> {
    const reason = window.prompt('Enroll this repository from now? Historical evidence remains blocked unless separately authorized.\n\nEnter an audit reason:')?.trim();
    if (!reason) return;
    await mutate(() => enrollAdminRepository(repositoryId, reason));
  }

  async function createGrant(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const branchPatterns = grantForm.branches.split(',')
      .map(value => value.trim()).filter(Boolean);
    const succeeded = await mutate(() => grantAdminMachineRepository({
      machineId: grantForm.machineId,
      enrollmentId: grantForm.enrollmentId,
      branchPatterns,
      reason: grantForm.reason,
    }));
    if (succeeded) {
      setGrantForm({ machineId: '', enrollmentId: '', branches: '', reason: '' });
    }
  }

  function beginBranchScopeEdit(grant: AdminRepositoryResources['grants'][number]): void {
    setMutationError(null);
    setBranchScopeError(null);
    setBranchScopeEdit({
      grantId: grant.id,
      mode: grant.branchPatterns.length === 0 ? 'all' : 'selected',
      patterns: [...grant.branchPatterns],
      draft: '',
      reason: '',
    });
  }

  function addBranchPattern(): void {
    if (!branchScopeEdit) return;
    const pattern = branchScopeEdit.draft.trim();
    if (!pattern) return;
    if (pattern.startsWith('/') || pattern.includes('..') || pattern.includes('refs/heads/')
      || (pattern.includes('*') && !(pattern.endsWith('/*') && pattern.indexOf('*') === pattern.length - 1))) {
      setBranchScopeError('Use an exact branch such as main or a prefix pattern such as feature/*.');
      return;
    }
    setBranchScopeError(null);
    setBranchScopeEdit({
      ...branchScopeEdit,
      mode: 'selected',
      patterns: [...new Set([...branchScopeEdit.patterns, pattern])],
      draft: '',
    });
  }

  async function saveBranchScope(): Promise<void> {
    if (!branchScopeEdit) return;
    if (branchScopeEdit.mode === 'selected' && branchScopeEdit.patterns.length === 0) {
      setBranchScopeError('Add at least one branch pattern, select All branches, or revoke machine access.');
      return;
    }
    if (!branchScopeEdit.reason.trim()) {
      setBranchScopeError('Enter an audit reason before saving this branch change.');
      return;
    }
    setMutationBusy(true);
    setBranchScopeError(null);
    try {
      await replaceAdminMachineRepositoryGrantBranchScope(
        branchScopeEdit.grantId,
        branchScopeEdit.mode === 'all' ? [] : branchScopeEdit.patterns,
        branchScopeEdit.reason,
      );
      setBranchScopeEdit(null);
      onChanged();
    } catch (cause) {
      setBranchScopeError(cause instanceof Error ? cause.message : 'Branch-scope replacement failed.');
    } finally {
      setMutationBusy(false);
    }
  }

  async function createBackfillAuthorization(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!window.confirm(
      'Authorize this exact historical evidence window? This does not replay data by itself and expires automatically.',
    )) return;
    const succeeded = await mutate(() => authorizeAdminRepositoryBackfill({
      enrollmentId: backfillForm.enrollmentId,
      evidenceFamily: backfillForm.evidenceFamily,
      occurredFrom: new Date(backfillForm.occurredFrom).toISOString(),
      occurredUntil: new Date(backfillForm.occurredUntil).toISOString(),
      expiresAt: new Date(backfillForm.expiresAt).toISOString(),
      reason: backfillForm.reason,
    }));
    if (succeeded) setBackfillForm({ ...backfillForm, enrollmentId: '', reason: '' });
  }

  function setBackfillScope(
    enrollmentId: string,
    evidenceFamily: 'generation_session' | 'commit_note',
  ): void {
    const enrollment = resources?.repositories?.enrollments.find(row => row.id === enrollmentId);
    if (!enrollment) {
      setBackfillForm({ ...backfillForm, enrollmentId, evidenceFamily });
      return;
    }
    const watermark = evidenceFamily === 'generation_session'
      ? enrollment.generationSessionEvidenceFrom
      : enrollment.commitNoteEvidenceFrom;
    const occurredUntil = new Date(new Date(watermark).getTime() - 60_000);
    const occurredFrom = new Date(occurredUntil.getTime() - 24 * 60 * 60 * 1_000);
    setBackfillForm({
      ...backfillForm,
      enrollmentId,
      evidenceFamily,
      occurredFrom: localDateTimeValue(occurredFrom),
      occurredUntil: localDateTimeValue(occurredUntil),
      expiresAt: localDateTimeValue(new Date(Date.now() + 60 * 60 * 1_000)),
    });
  }

  function enrollmentAlreadyGrantedToSelectedMachine(enrollmentId: string): boolean {
    if (!grantForm.machineId) return false;
    return resources?.repositories?.grants.some(grant => (
      grant.machineId === grantForm.machineId
      && grant.enrollmentId === enrollmentId
      && grant.status === 'active'
      && (!grant.effectiveUntil || new Date(grant.effectiveUntil).getTime() > Date.now())
    )) ?? false;
  }

  function enrollmentHasActiveBackfill(
    enrollmentId: string,
    evidenceFamily: 'generation_session' | 'commit_note',
  ): boolean {
    return resources?.backfills?.authorizations.some(authorization => (
      authorization.enrollmentId === enrollmentId
      && authorization.evidenceFamily === evidenceFamily
      && authorization.status === 'active'
      && new Date(authorization.expiresAt).getTime() > Date.now()
    )) ?? false;
  }

  const filteredAdminRepositories = useMemo(() => {
    const repositoryResources = resources?.repositories;
    if (!repositoryResources) return [];
    const search = repositorySearch.trim().toLowerCase();
    return repositoryResources.repositories.filter(repository => {
      const enrollment = repositoryResources.enrollments.find(row => row.repositoryId === repository.id);
      const isActive = enrollment?.status === 'active';
      const statusMatches = repositoryStatus === 'all'
        || (repositoryStatus === 'active' && isActive)
        || (repositoryStatus === 'unenrolled' && !isActive);
      const searchMatches = !search || [repository.name, repository.url, repository.normalizedUrl]
        .some(value => value?.toLowerCase().includes(search));
      return statusMatches && searchMatches;
    });
  }, [repositorySearch, repositoryStatus, resources?.repositories]);

  const customerAdminRepositories = filteredAdminRepositories.filter(
    repository => !isTask4VerificationRepository(repository),
  );
  const verificationAdminRepositories = filteredAdminRepositories.filter(
    isTask4VerificationRepository,
  );
  const activeAdminMachines = resources?.machines?.machines.filter(
    machine => machine.status === 'active',
  ) ?? [];
  const historicalAdminMachines = resources?.machines?.machines.filter(
    machine => machine.status !== 'active',
  ) ?? [];

  const selectedAdminRepository = customerAdminRepositories.find(
    repository => repository.id === selectedRepositoryId,
  ) ?? customerAdminRepositories[0] ?? null;
  const selectedAdminEnrollment = selectedAdminRepository
    ? resources?.repositories?.enrollments.find(row => row.repositoryId === selectedAdminRepository.id) ?? null
    : null;

  function selectAdminRepository(repositoryId: string): void {
    const enrollment = resources?.repositories?.enrollments.find(row => row.repositoryId === repositoryId);
    setSelectedRepositoryId(repositoryId);
    setGrantForm({
      machineId: '',
      enrollmentId: enrollment?.status === 'active' ? enrollment.id : '',
      branches: '',
      reason: '',
    });
  }

  return <div className="space-y-6">
    {!active && <div className="max-w-3xl rounded-xl border border-slate-800 bg-slate-900/60 p-6"><div className="flex items-center justify-between"><div><h2 className="font-semibold text-white">Administrator access</h2><p className="mt-1 text-sm text-slate-500">Explicit subject-bound authorization for this tenant</p></div><Badge tone="amber">{context?.membership?.status === 'revoked' ? 'Revoked' : 'Not provisioned'}</Badge></div><div className="mt-6 space-y-3 text-sm"><div><div className="text-xs uppercase tracking-wider text-slate-500">Tenant</div><div className="mt-1 font-mono text-slate-300">{context?.tenantId ?? 'Unavailable'}</div></div><div><div className="text-xs uppercase tracking-wider text-slate-500">Verified JWT subject</div><div className="mt-1 break-all rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-slate-300">{context?.subject ?? 'Unavailable'}</div></div></div>{!context?.membership && <div className="mt-6 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200">Access has not been granted. Give this exact subject to the system operator for the dry-run bootstrap. Your email domain selects the tenant but never grants administrator rights.</div>}{context?.membership?.status === 'revoked' && <div className="mt-6 rounded-lg border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-200">This administrator membership is revoked. Resource controls remain unavailable.</div>}</div>}
    {active && <div className="flex justify-end"><details className="relative rounded-lg border border-slate-800 bg-slate-900/60 text-sm"><summary className="cursor-pointer list-none px-3 py-2 text-slate-400 hover:text-white">⚙ Access details</summary><div className="absolute right-0 z-20 mt-2 w-[32rem] max-w-[80vw] rounded-xl border border-slate-700 bg-slate-950 p-5 shadow-2xl"><div className="flex items-center justify-between"><h2 className="font-semibold text-white">Administrator access</h2><Badge tone="green">{context?.membership?.role.replace('_', ' ')}</Badge></div><div className="mt-4 space-y-3"><div><div className="text-xs uppercase tracking-wider text-slate-500">Tenant</div><div className="mt-1 break-all font-mono text-xs text-slate-300">{context?.tenantId ?? 'Unavailable'}</div></div><div><div className="text-xs uppercase tracking-wider text-slate-500">Verified JWT subject</div><div className="mt-1 break-all font-mono text-xs text-slate-300">{context?.subject ?? 'Unavailable'}</div></div></div></div></details></div>}
    {loading && !resources && <div className="rounded-xl border border-slate-800 p-5 text-sm text-slate-400">Loading protected administration metadata…</div>}
    {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-5 text-sm text-rose-200">{error}</div>}
    {mutationError && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-5 text-sm text-rose-200">{mutationError}</div>}
    {oneTimeCredential && <div ref={credentialPanelRef} className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5"><div className="flex items-center justify-between gap-4"><div><h2 className="font-semibold text-amber-100">Save this one-time machine credential now</h2><p className="mt-1 text-sm text-amber-200/80">Copy the full value beginning with <span className="font-mono">trk_v1.</span>. It is not stored by the server and cannot be shown again.</p></div><button onClick={() => { setOneTimeCredential(null); setCredentialCopied(false); }} className="rounded-lg border border-amber-400/30 px-3 py-2 text-sm text-amber-100">Dismiss after saving</button></div><div className="mt-4 text-xs uppercase tracking-wider text-slate-400">Reference key ID — do not put this alone in the keyring</div><div className="mt-1 break-all font-mono text-sm text-slate-300">{oneTimeCredential.keyId}</div><div className="mt-4 flex items-center justify-between"><div className="text-xs uppercase tracking-wider text-amber-300">Complete one-time credential — starts with trk_v1.</div><button onClick={() => void navigator.clipboard.writeText(oneTimeCredential.plaintext).then(() => setCredentialCopied(true)).catch(() => setMutationError('Browser clipboard access failed; select the complete credential manually.'))} className="rounded-lg bg-amber-300 px-3 py-2 text-xs font-semibold text-slate-950">{credentialCopied ? 'Copied' : 'Copy complete credential'}</button></div><div className="mt-2 break-all rounded-lg border border-amber-400/20 bg-slate-950 p-3 font-mono text-sm text-amber-100">{oneTimeCredential.plaintext}</div></div>}
    {active && resources && <>
      <nav aria-label="Administration sections" className="grid gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-2 sm:grid-cols-2 xl:grid-cols-6">
        {adminNavigation.map(item => <button key={item.id} type="button" onClick={() => setAdminSection(item.id)} className={`rounded-lg px-3 py-3 text-left transition ${adminSection === item.id ? 'bg-violet-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}><span className="block text-sm font-medium">{item.label}</span><span className={`mt-1 block text-xs ${adminSection === item.id ? 'text-violet-100' : 'text-slate-500'}`}>{item.description}</span></button>)}
      </nav>
      {adminSection === 'overview' && <section className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Metric label="Active machines" value={resources.machines?.machines.filter(row => row.status === 'active').length ?? 'Audit only'} /><Metric label="Enrolled repositories" value={resources.repositories?.enrollments.filter(row => row.status === 'active').length ?? 'Audit only'} /><Metric label="GitHub installations" value={resources.github?.installations.filter(row => row.status === 'active').length ?? 'Audit only'} /><Metric label="Recent audit events" value={resources.audit.events.length} /></div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6"><h2 className="font-semibold text-white">Recommended setup flow</h2><p className="mt-1 text-sm text-slate-500">Complete the first four steps for each developer installation. Historical import is optional.</p><div className="mt-5 grid gap-3 lg:grid-cols-5">{[
          ['1', 'Register machine', 'Create one logical installation.', 'machines' as AdminSection],
          ['2', 'Install key', 'Issue and securely install its credential.', 'machines' as AdminSection],
          ['3', 'Enroll repository', 'Allow this tenant to receive new evidence.', 'repositories' as AdminSection],
          ['4', 'Grant access', 'Choose which machine and branches may send.', 'repositories' as AdminSection],
          ['5', 'Older evidence', 'Optionally open a narrow, expiring import window.', 'history' as AdminSection],
        ].map(([number, title, description, target]) => <button key={number} type="button" onClick={() => setAdminSection(target as AdminSection)} className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-left hover:border-violet-500/50"><span className="text-xs font-semibold text-violet-300">STEP {number}</span><span className="mt-2 block text-sm font-medium text-white">{title}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span></button>)}</div></div>
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-5 text-sm text-cyan-100"><strong>What “historical import” means:</strong> TrackAI normally accepts evidence only from the time a repository is enrolled. This optional control temporarily permits already-saved evidence from one earlier time window. It does not invent data, scan GitHub, or start replaying anything by itself.</div>
      </section>}
      {adminSection === 'machines' && resources.machines && <section className="space-y-4">
        <div><h2 className="font-semibold text-white">Developer machines</h2><p className="mt-1 text-sm text-slate-500">A credential revoke affects one key. A machine-installation revoke also revokes every active credential and repository grant owned by that installation.</p></div>
        <form onSubmit={(event) => void registerMachine(event)} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4"><input required value={machineForm.installationId} onChange={(event) => setMachineForm({ ...machineForm, installationId: event.target.value })} placeholder="Installation ID (for example manish-mac)" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"/><input required value={machineForm.displayName} onChange={(event) => setMachineForm({ ...machineForm, displayName: event.target.value })} placeholder="Display name" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"/><input value={machineForm.platform} onChange={(event) => setMachineForm({ ...machineForm, platform: event.target.value })} placeholder="Platform (optional)" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"/><button disabled={mutationBusy} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Register</button></form>
        <TableShell headers={['Machine', 'Installation', 'Status', 'Credentials', 'Last seen', 'Installation actions']}>{activeAdminMachines.map((machine) => { const credentials = resources.machines?.credentials.filter((credential) => credential.machineId === machine.id) ?? []; const activeCredentials = credentials.filter((credential) => credential.status === 'active'); return <tr key={machine.id}><td className="px-5 py-4 font-medium text-white">{machine.displayName}<div className="text-xs text-slate-500">{machine.platform ?? 'Platform unavailable'}</div></td><td className="px-5 py-4 font-mono text-xs text-slate-400">{machine.installationId}</td><td className="px-5 py-4"><Badge tone="green">{machine.status}</Badge></td><td className="px-5 py-4"><div>{activeCredentials.length} active</div>{credentials.map((credential) => <div key={credential.id} className="mt-2 flex items-center gap-2 text-xs text-slate-500"><span className="font-mono">{credential.keyId}</span><Badge tone={credential.status === 'active' ? 'green' : 'slate'}>{credential.status}</Badge>{credential.status === 'active' && <>{activeCredentials.length === 1 && <button disabled={mutationBusy || Boolean(oneTimeCredential)} onClick={() => void issueCredential(machine.id, credential.id)} className="text-violet-300 hover:text-violet-200 disabled:text-slate-600">Stage rotation</button>}<button disabled={mutationBusy} onClick={() => void reasonedMutation('Revoke only this credential key?', (reason) => revokeAdminMachineCredential(credential.id, reason))} className="text-rose-300 hover:text-rose-200">Revoke credential</button></>}</div>)}</td><td className="px-5 py-4 text-slate-500">{date(machine.lastSeenAt)}</td><td className="px-5 py-4"><div className="flex flex-col items-start gap-2">{activeCredentials.length === 0 && <button disabled={mutationBusy || Boolean(oneTimeCredential)} onClick={() => void issueCredential(machine.id)} className="text-sm text-violet-300 hover:text-violet-200 disabled:text-slate-600">Issue credential</button>}<button disabled={mutationBusy} onClick={() => void reasonedMutation('Revoke this logical machine installation, every active credential, and every active repository grant it owns?', (reason) => revokeAdminMachine(machine.id, reason))} className="text-sm text-rose-300 hover:text-rose-200">Revoke machine installation</button></div></td></tr>; })}</TableShell>
        {activeAdminMachines.length === 0 && <div className="rounded-xl border border-slate-800 p-5 text-sm text-slate-500">No active machine installations.</div>}
        {historicalAdminMachines.length > 0 && <details className="rounded-xl border border-slate-800 bg-slate-900/40"><summary className="cursor-pointer px-5 py-4 text-sm font-medium text-slate-300">Revoked machine history ({historicalAdminMachines.length})</summary><div className="border-t border-slate-800"><TableShell headers={['Machine', 'Installation', 'Status', 'Revoked']}>{historicalAdminMachines.map(machine => <tr key={machine.id}><td className="px-5 py-4 text-slate-300">{machine.displayName}</td><td className="px-5 py-4 font-mono text-xs text-slate-500">{machine.installationId}</td><td className="px-5 py-4"><Badge tone="slate">{machine.status}</Badge></td><td className="px-5 py-4 text-slate-500">{date(machine.revokedAt)}</td></tr>)}</TableShell></div></details>}
      </section>}
      {adminSection === 'repositories' && resources.repositories && <section className="space-y-4">
        <div><h2 className="font-semibold text-white">Repository access</h2><p className="mt-1 text-sm text-slate-500">The list summarizes current access. Select one repository to inspect branch rules, manage machines, or view revoked history.</p></div>
        <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:grid-cols-[1fr_auto]">
          <input value={repositorySearch} onChange={(event) => setRepositorySearch(event.target.value)} placeholder="Search repositories by name or URL" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"/>
          <div className="flex rounded-lg border border-slate-700 bg-slate-950 p-1">{(['all', 'active', 'unenrolled'] as const).map(status => <button key={status} type="button" onClick={() => setRepositoryStatus(status)} className={`rounded-md px-3 py-1.5 text-xs capitalize ${repositoryStatus === status ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}>{status}</button>)}</div>
        </div>
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(19rem,0.85fr)_minmax(0,1.6fr)]">
          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
            <div className="border-b border-slate-800 px-4 py-3 text-xs uppercase tracking-wider text-slate-500">{customerAdminRepositories.length} customer repositories</div>
            <div className="max-h-[42rem] divide-y divide-slate-800 overflow-y-auto">{customerAdminRepositories.length ? customerAdminRepositories.map(repository => { const enrollment = resources.repositories?.enrollments.find(row => row.repositoryId === repository.id); const grants = enrollment ? resources.repositories?.grants.filter(grant => grant.enrollmentId === enrollment.id && grant.status === 'active' && (!grant.effectiveUntil || new Date(grant.effectiveUntil).getTime() > Date.now())) ?? [] : []; const machineCount = new Set(grants.map(grant => grant.machineId)).size; const branchPatterns = [...new Set(grants.flatMap(grant => grant.branchPatterns))]; const branchSummary = grants.some(grant => grant.branchPatterns.length === 0) ? 'All branches' : branchPatterns.length ? `${branchPatterns.length} branch ${branchPatterns.length === 1 ? 'rule' : 'rules'}` : 'No active access'; const selected = selectedAdminRepository?.id === repository.id; return <button key={repository.id} type="button" onClick={() => selectAdminRepository(repository.id)} className={`block w-full p-4 text-left transition ${selected ? 'bg-violet-500/10 ring-1 ring-inset ring-violet-500/40' : 'hover:bg-slate-800/50'}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-sm font-medium text-white">{repository.name}</div><div className="mt-1 truncate text-xs text-slate-500">{repository.normalizedUrl ?? repository.url}</div></div><Badge tone={enrollment?.status === 'active' ? 'green' : 'slate'}>{enrollment?.status === 'active' ? 'enrolled' : 'not enrolled'}</Badge></div><div className="mt-3 flex gap-4 text-xs text-slate-400"><span>{machineCount} active {machineCount === 1 ? 'machine' : 'machines'}</span><span>{branchSummary}</span></div></button>; }) : <div className="p-6 text-sm text-slate-500">No customer repositories match this filter.</div>}</div>
            {verificationAdminRepositories.length > 0 && <details className="border-t border-slate-800 bg-slate-950/40"><summary className="cursor-pointer px-4 py-3 text-xs font-medium text-slate-400">Retained verification fixtures ({verificationAdminRepositories.length})</summary><div className="border-t border-slate-800 px-4 py-3 text-xs text-slate-500">These revoked Task4 test records are retained for audit and excluded from customer policy controls by default.</div><div className="divide-y divide-slate-800 border-t border-slate-800">{verificationAdminRepositories.map(repository => <div key={repository.id} className="p-4"><div className="truncate text-xs font-medium text-slate-400">{repository.name}</div><div className="mt-1 truncate text-xs text-slate-600">{repository.normalizedUrl ?? repository.url}</div></div>)}</div></details>}
          </div>
          {selectedAdminRepository ? (() => { const enrollment = selectedAdminEnrollment; const grants = enrollment ? resources.repositories?.grants.filter(grant => grant.enrollmentId === enrollment.id) ?? [] : []; const now = Date.now(); const activeGrants = grants.filter(grant => grant.status === 'active' && (!grant.effectiveUntil || new Date(grant.effectiveUntil).getTime() > now)); const historicalGrants = grants.filter(grant => !activeGrants.includes(grant)); const availableMachines = resources.machines?.machines.filter(machine => machine.status === 'active' && !activeGrants.some(grant => grant.machineId === machine.id)) ?? []; return <div className="space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="text-xs uppercase tracking-wider text-violet-300">Selected repository</div><h3 className="mt-2 text-lg font-semibold text-white">{selectedAdminRepository.name}</h3><div className="mt-1 text-xs text-slate-500">{selectedAdminRepository.normalizedUrl ?? selectedAdminRepository.url}</div></div><Badge tone={enrollment?.status === 'active' ? 'green' : 'slate'}>{enrollment?.status === 'active' ? 'enrolled' : 'not enrolled'}</Badge></div>{enrollment?.status === 'active' ? <div className="mt-5 grid gap-3 sm:grid-cols-2"><Metric label="Generation accepted from" value={<span className="text-sm">{date(enrollment.generationSessionEvidenceFrom)}</span>} /><Metric label="Commit / Notes accepted from" value={<span className="text-sm">{date(enrollment.commitNoteEvidenceFrom)}</span>} /></div> : <div className="mt-5 flex items-center justify-between gap-4 rounded-lg border border-violet-500/20 bg-violet-500/5 p-4"><p className="text-sm text-slate-300">Enroll this repository to accept new evidence. Historical evidence remains blocked unless separately authorized.</p><button disabled={mutationBusy} onClick={() => void enroll(selectedAdminRepository.id)} className="shrink-0 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Enroll from now</button></div>}</div>
            {enrollment?.status === 'active' && resources.machines && <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5"><div><h3 className="font-medium text-white">Grant a machine access</h3><p className="mt-1 text-xs text-slate-500">One active grant per machine and repository. Leave branch scope blank for all branches, or enter exact names and prefix rules such as main, feature/*.</p></div>{availableMachines.length ? <form onSubmit={(event) => void createGrant(event)} className="mt-4 grid gap-3 sm:grid-cols-2"><select required value={grantForm.machineId} onChange={(event) => setGrantForm({ ...grantForm, machineId: event.target.value, enrollmentId: enrollment.id })} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"><option value="">Select a machine without active access</option>{availableMachines.map(machine => <option key={machine.id} value={machine.id}>{machine.displayName}</option>)}</select><input value={grantForm.branches} onChange={(event) => setGrantForm({ ...grantForm, enrollmentId: enrollment.id, branches: event.target.value })} placeholder="main, feature/* — blank allows all" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"/><input required value={grantForm.reason} onChange={(event) => setGrantForm({ ...grantForm, enrollmentId: enrollment.id, reason: event.target.value })} placeholder="Audit reason" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm sm:col-span-2"/><div className="flex justify-end sm:col-span-2"><button disabled={mutationBusy || !grantForm.machineId} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Grant machine access</button></div></form> : <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">Every active machine in this tenant already has access to this repository. Revoked machines and machines from other tenants are intentionally excluded.</div>}</div>}
            {enrollment?.status === 'active' && <div className="space-y-3"><div className="flex items-end justify-between"><div><h3 className="font-medium text-white">Active machine access</h3><p className="mt-1 text-xs text-slate-500">{activeGrants.length} current {activeGrants.length === 1 ? 'grant' : 'grants'}. Edit the branch set without creating parallel active grants.</p></div></div>{activeGrants.length ? <TableShell headers={['Machine', 'Branch scope', 'Effective from', 'Action']}>{activeGrants.map(grant => <tr key={grant.id}><td className="px-5 py-4 font-medium text-white">{resources.machines?.machines.find(machine => machine.id === grant.machineId)?.displayName ?? 'Unknown machine'}</td><td className="px-5 py-4"><div className="flex flex-wrap gap-1.5">{grant.branchPatterns.length ? grant.branchPatterns.map(pattern => <span key={pattern} className="rounded-md bg-slate-800 px-2 py-1 font-mono text-xs text-slate-300">{pattern}</span>) : <Badge tone="violet">All branches</Badge>}</div>{branchScopeEdit?.grantId === grant.id ? <div className="mt-3 space-y-3 rounded-lg border border-violet-500/30 bg-slate-950 p-3"><div className="flex gap-2"><button type="button" onClick={() => { setBranchScopeError(null); setBranchScopeEdit({ ...branchScopeEdit, mode: 'all' }); }} className={`rounded-md px-3 py-1.5 text-xs ${branchScopeEdit.mode === 'all' ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300'}`}>All branches</button><button type="button" onClick={() => { setBranchScopeError(null); setBranchScopeEdit({ ...branchScopeEdit, mode: 'selected' }); }} className={`rounded-md px-3 py-1.5 text-xs ${branchScopeEdit.mode === 'selected' ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300'}`}>Selected branches</button></div>{branchScopeEdit.mode === 'selected' && <><div className="flex flex-wrap gap-1.5">{branchScopeEdit.patterns.map(pattern => <button key={pattern} type="button" title="Remove branch pattern" onClick={() => { setBranchScopeError(null); setBranchScopeEdit({ ...branchScopeEdit, patterns: branchScopeEdit.patterns.filter(item => item !== pattern) }); }} className="rounded-md bg-slate-800 px-2 py-1 font-mono text-xs text-slate-200 hover:bg-rose-500/20">{pattern} ×</button>)}</div><div className="flex gap-2"><input value={branchScopeEdit.draft} onChange={(event) => { setBranchScopeError(null); setBranchScopeEdit({ ...branchScopeEdit, draft: event.target.value }); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addBranchPattern(); } }} placeholder="Add main or feature/*" className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs"/><button type="button" onClick={addBranchPattern} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-200">Add</button></div></>}<input value={branchScopeEdit.reason} onChange={(event) => { setBranchScopeError(null); setBranchScopeEdit({ ...branchScopeEdit, reason: event.target.value }); }} placeholder="Audit reason for this branch change" className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs"/>{branchScopeError && <div role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{branchScopeError}</div>}<div className="flex justify-end gap-2"><button type="button" onClick={() => { setBranchScopeEdit(null); setBranchScopeError(null); }} className="px-3 py-1.5 text-xs text-slate-400">Cancel</button><button type="button" disabled={mutationBusy} onClick={() => void saveBranchScope()} className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Save branch scope</button></div></div> : <button type="button" disabled={mutationBusy || Boolean(branchScopeEdit)} onClick={() => beginBranchScopeEdit(grant)} className="mt-2 text-xs text-violet-300 hover:text-violet-200 disabled:text-slate-600">Edit branch scope</button>}</td><td className="px-5 py-4 text-slate-500">{date(grant.effectiveFrom)}</td><td className="px-5 py-4"><button disabled={mutationBusy} onClick={() => void reasonedMutation('Revoke only this machine\'s access to this repository?', reason => revokeAdminMachineRepositoryGrant(grant.id, reason))} className="text-sm text-rose-300 hover:text-rose-200">Revoke access</button></td></tr>)}</TableShell> : <div className="rounded-xl border border-slate-800 p-5 text-sm text-slate-500">No machines currently have access.</div>}</div>}
            {historicalGrants.length > 0 && <details className="rounded-xl border border-slate-800 bg-slate-900/40"><summary className="cursor-pointer px-5 py-4 text-sm font-medium text-slate-300">Revoked and expired access history ({historicalGrants.length})</summary><div className="border-t border-slate-800"><TableShell headers={['Machine', 'Branch scope', 'Status', 'Revoked / expired']}>{historicalGrants.map(grant => <tr key={grant.id}><td className="px-5 py-4 text-slate-300">{resources.machines?.machines.find(machine => machine.id === grant.machineId)?.displayName ?? 'Unknown machine'}</td><td className="px-5 py-4 font-mono text-xs text-slate-500">{grant.branchPatterns.length ? grant.branchPatterns.join(', ') : 'all branches'}</td><td className="px-5 py-4"><Badge tone="slate">{grant.status === 'revoked' ? 'revoked' : 'expired'}</Badge></td><td className="px-5 py-4 text-slate-500">{date(grant.revokedAt ?? grant.effectiveUntil)}</td></tr>)}</TableShell></div></details>}
            {enrollment?.status === 'active' && <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-5"><h3 className="font-medium text-rose-200">Repository policy danger zone</h3><p className="mt-1 text-sm text-rose-200/70">Revoking the repository policy blocks this repository for every machine and also revokes its active grants and historical-import authorizations. It does not revoke the machines or their credentials.</p><button disabled={mutationBusy} onClick={() => void reasonedMutation('Revoke this tenant repository policy, every active machine grant, and every active historical-import authorization?', reason => revokeAdminRepositoryEnrollment(enrollment.id, reason))} className="mt-4 rounded-lg border border-rose-500/40 px-4 py-2 text-sm font-medium text-rose-200 hover:bg-rose-500/10 disabled:opacity-50">Revoke repository policy</button></div>}
          </div>; })() : <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-sm text-slate-500">Choose a repository to inspect its access policy.</div>}
        </div>
      </section>}
      {adminSection === 'github' && resources.github && <section><div className="mb-4"><h2 className="font-semibold text-white">GitHub App installations</h2><p className="mt-1 text-sm text-slate-500">Read-only organization connections used by the server. Machine credentials are managed separately.</p></div><TableShell headers={['Account', 'Installation', 'Permissions', 'Status', 'Updated']}>{resources.github.installations.map((installation) => <tr key={installation.id}><td className="px-5 py-4 font-medium text-white">{installation.accountLogin}</td><td className="px-5 py-4 font-mono text-xs text-slate-400">{installation.installationExternalId}</td><td className="px-5 py-4 text-slate-400">{Object.entries(installation.permissions).map(([name, level]) => `${name}:${level}`).join(', ')}</td><td className="px-5 py-4"><Badge tone={installation.status === 'active' ? 'green' : 'slate'}>{installation.status}</Badge></td><td className="px-5 py-4 text-slate-500">{date(installation.updatedAt)}</td></tr>)}</TableShell></section>}
      {adminSection === 'history' && resources.backfills && resources.repositories && <section className="space-y-4">
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-5"><h2 className="font-semibold text-cyan-100">Historical import <span className="font-normal text-cyan-300/70">(controlled backfill)</span></h2><p className="mt-2 text-sm leading-6 text-cyan-100/80">Use this only when a machine already holds older TrackAI evidence that predates repository enrollment. You permit one repository, one evidence type, and one past time window for at most 24 hours. The client must still explicitly replay that saved evidence.</p><p className="mt-2 text-xs text-cyan-300/70">It never creates missing evidence, scans GitHub, or changes Task2 lifecycle definitions.</p></div>
        {resources.repositories.enrollments.some(enrollment => enrollment.status === 'active') && <form onSubmit={(event) => void createBackfillAuthorization(event)} className="grid grid-cols-2 gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <select value={backfillForm.evidenceFamily} onChange={(event) => setBackfillScope('', event.target.value as 'generation_session' | 'commit_note')} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"><option value="generation_session">Generation / session</option><option value="commit_note">Commit / Git Notes</option></select>
          <select required value={backfillForm.enrollmentId} onChange={(event) => setBackfillScope(event.target.value, backfillForm.evidenceFamily)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"><option value="">Select a repository without an active authorization</option>{resources.repositories.enrollments.filter(enrollment => enrollment.status === 'active' && !enrollmentHasActiveBackfill(enrollment.id, backfillForm.evidenceFamily)).map(enrollment => <option key={enrollment.id} value={enrollment.id}>{resources.repositories?.repositories.find(repository => repository.id === enrollment.repositoryId)?.name ?? enrollment.id}</option>)}</select>
          <label className="text-xs text-slate-500">Evidence from<input required type="datetime-local" value={backfillForm.occurredFrom} onChange={(event) => setBackfillForm({ ...backfillForm, occurredFrom: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"/></label>
          <label className="text-xs text-slate-500">Evidence until<input required type="datetime-local" value={backfillForm.occurredUntil} onChange={(event) => setBackfillForm({ ...backfillForm, occurredUntil: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"/></label>
          <label className="text-xs text-slate-500">Authorization expires<input required type="datetime-local" value={backfillForm.expiresAt} onChange={(event) => setBackfillForm({ ...backfillForm, expiresAt: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"/></label>
          <label className="text-xs text-slate-500">Audit reason<input required value={backfillForm.reason} onChange={(event) => setBackfillForm({ ...backfillForm, reason: event.target.value })} placeholder="Why is historical ingestion required?" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"/></label>
          <div className="col-span-2 flex justify-end"><button disabled={mutationBusy || !backfillForm.enrollmentId} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Authorize bounded backfill</button></div>
        </form>}
        <TableShell headers={['Repository', 'Evidence family', 'Window', 'Expires', 'Status', 'Reason', 'Actions']}>{resources.backfills.authorizations.length ? resources.backfills.authorizations.map((authorization) => { const enrollment = resources.repositories?.enrollments.find(row => row.id === authorization.enrollmentId); const repository = resources.repositories?.repositories.find(row => row.id === enrollment?.repositoryId); return <tr key={authorization.id}><td className="px-5 py-4 font-medium text-white">{repository?.name ?? 'Unknown repository'}</td><td className="px-5 py-4">{authorization.evidenceFamily.replace('_', ' / ')}</td><td className="px-5 py-4 text-slate-500">{date(authorization.occurredFrom)} → {date(authorization.occurredUntil)}</td><td className="px-5 py-4 text-slate-500">{date(authorization.expiresAt)}</td><td className="px-5 py-4"><Badge tone={authorization.status === 'active' ? 'green' : 'slate'}>{authorization.status}</Badge></td><td className="px-5 py-4 text-slate-400">{authorization.reason}</td><td className="px-5 py-4">{authorization.status === 'active' && <button disabled={mutationBusy} onClick={() => void reasonedMutation('Revoke this backfill authorization?', reason => revokeAdminRepositoryBackfill(authorization.id, reason))} className="text-sm text-rose-300 hover:text-rose-200">Revoke authorization</button>}</td></tr>; }) : <tr><td colSpan={7} className="px-5 py-5 text-slate-500">No backfill authorizations.</td></tr>}</TableShell>
      </section>}
      {adminSection === 'audit' && <section><div className="mb-4"><h2 className="font-semibold text-white">Security audit</h2><p className="mt-1 text-sm text-slate-500">Immutable history of administrative security changes. Revoking a resource does not erase its earlier entries.</p></div><TableShell headers={['Time', 'Action', 'Actor type', 'Target']}>{resources.audit.events.map((event) => <tr key={event.id}><td className="px-5 py-4 text-slate-500">{date(event.occurredAt)}</td><td className="px-5 py-4 font-medium text-white">{event.action}</td><td className="px-5 py-4 text-slate-400">{event.actorType}</td><td className="px-5 py-4 text-slate-500">{event.targetType}</td></tr>)}</TableShell></section>}
    </>}
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
  const [models, setModels] = useState<TelemetryModel[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [commits, setCommits] = useState<CommitListItem[]>([]);
  const [detail, setDetail] = useState<Detail>(null);
  const [lifecycleScope, setLifecycleScope] = useState('tenant');
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [adminContext, setAdminContext] = useState<AdminContext | null>(null);
  const [adminResources, setAdminResources] = useState<AdminResources | null>(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  const refresh = useCallback(async (initial = false) => {
    try {
      if (initial) setLoading(true);
      const [summaryData, repositoryData, pullRequestData, contributorData, modelData, sessionData, commitData, lifecycleData, adminData] = await Promise.all([
        getDashboardSummary(), getRepositories(), getPullRequests(), getContributors(), getModels(), getSessions(), getCommits(), getLifecycle(lifecycleQuery(lifecycleScope)), getAdminContext(),
      ]);
      setSummary(summaryData); setRepositories(repositoryData); setPullRequests(pullRequestData);
      setContributors(contributorData); setModels(modelData); setSessions(sessionData); setCommits(commitData);
      setLifecycle(lifecycleData);
      setAdminContext(adminData);
      if (adminData.membership?.status === 'active') {
        setAdminLoading(true);
        void (async () => {
          try {
            const audit = await getAdminAudit();
            if (adminData.membership?.role === 'tenant_auditor') {
              setAdminResources({ machines: null, repositories: null, backfills: null, github: null, audit });
            } else {
              const [machines, repositories, backfills, github] = await Promise.all([
                getAdminMachines(), getAdminRepositoryPolicies(),
                getAdminBackfillAuthorizations(), getAdminGitHubInstallations(),
              ]);
              setAdminResources({ machines, repositories, backfills, github, audit });
            }
            setAdminError(null);
          } catch (cause) {
            setAdminError(cause instanceof Error ? cause.message : 'Failed to load administration metadata.');
          } finally {
            setAdminLoading(false);
          }
        })();
      } else {
        setAdminResources(null);
        setAdminError(null);
      }
      setLastUpdated(new Date()); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to load dashboard data.'); }
    finally { if (initial) setLoading(false); }
  }, [lifecycleScope]);

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
  const visibleTotals = view === 'lifecycle' && lifecycle?.totals
    ? lifecycle.totals
    : summary;

  async function openDetail(kind: 'session' | 'commit' | 'pullRequest', id: string) {
    const data = kind === 'session' ? await getSession(id) : kind === 'commit' ? await getCommit(id) : await getPullRequestIntelligence(id);
    setDetail({ kind, data });
  }

  async function signOut() { await supabase.auth.signOut(); router.replace('/login'); }

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">Loading tenant dashboard…</div>;

  return <div className="min-h-screen bg-slate-950 text-slate-200">
    <aside className="fixed inset-y-0 left-0 w-64 border-r border-slate-800 bg-slate-950 p-5">
      <div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500 font-bold text-white">T</div><div><div className="font-semibold text-white">TrackAI</div><div className="text-xs text-slate-500">Telemetry intelligence</div></div></div>
      <nav className="mt-10 space-y-1">{navigation.map((item) => <button key={item.id} onClick={() => setView(item.id)} className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm ${view === item.id ? 'bg-violet-500/15 text-violet-200' : 'text-slate-400 hover:bg-slate-900 hover:text-white'}`}><span>{item.label}</span><span className="text-xs text-slate-600">{item.id === 'lifecycle' ? 'Live' : item.id === 'sessions' ? sessions.length : item.id === 'commits' ? commits.length : item.id === 'pullRequests' ? pullRequests.length : item.id === 'repositories' ? repositories.length : item.id === 'contributors' ? contributors.length : adminContext?.membership?.status === 'active' ? adminContext.membership.role === 'tenant_admin' ? 'Admin' : 'Audit' : 'Setup'}</span></button>)}</nav>
      <div className="absolute bottom-5 left-5 right-5 border-t border-slate-800 pt-4"><div className="truncate text-xs text-slate-500">{email}</div><button onClick={signOut} className="mt-2 text-xs text-slate-400 hover:text-white">Sign out</button></div>
    </aside>
    <main className="ml-64 min-h-screen p-8">
      <header className="flex items-start justify-between gap-5"><div><div className="text-sm text-violet-400">{summary?.organizationName ?? 'Workspace'}</div><h1 className="mt-1 text-3xl font-semibold text-white">{navigation.find((row) => row.id === view)?.label}</h1><div className="mt-2 text-xs text-slate-600">Live protected API · refreshes every 15 seconds{lastUpdated ? ` · ${lastUpdated.toLocaleTimeString()}` : ''}</div></div><div className="flex gap-2">{view === 'lifecycle' && <select aria-label="Lifecycle metric scope" value={lifecycleScope} onChange={(event) => setLifecycleScope(event.target.value)} className="max-w-xs rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-violet-500"><option value="tenant">Entire tenant</option><optgroup label="Repositories">{repositories.map((row) => <option key={row.id} value={`repository:${row.id}`}>{row.name}</option>)}</optgroup><optgroup label="Pull requests">{pullRequests.map((row) => <option key={row.id} value={`pullRequest:${row.id}`}>{row.title}</option>)}</optgroup><optgroup label="Contributors">{contributors.map((row) => <option key={row.id} value={`contributor:${row.id}`}>{row.name}{row.email ? ` · ${row.email}` : ''}</option>)}</optgroup><optgroup label="Models">{models.map((row) => <option key={row.key} value={`model:${row.key}`}>{row.tool} · {row.model ?? 'Unknown model'}</option>)}</optgroup></select>}<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter rows…" className="w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-violet-500"/><button onClick={() => void refresh(false)} className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:border-violet-500">Refresh</button></div></header>
      {error && <div className="mt-5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-rose-200">{error}</div>}
      {view !== 'administration' && <div className="mt-7 grid grid-cols-4 gap-3"><Metric label="Sessions" value={visibleTotals?.sessions ?? 0}/><Metric label={view === 'lifecycle' ? 'Retained commits' : 'Historical commits'} value={view === 'lifecycle' ? (visibleTotals?.commits ?? 0) : (summary?.historicalCommits ?? summary?.commits ?? 0)}/><Metric label="Final AI lines" value={visibleTotals?.finalAiLines ?? 0}/><Metric label="Human lines" value={visibleTotals?.finalHumanLines ?? 0}/></div>}
      <section className="mt-7">
        {view === 'lifecycle' && <LifecycleFlow data={lifecycle} />}
        {view === 'sessions' && <TableShell headers={['Session', 'Agent / model', 'Repository', 'Retained / historical commits', 'Tokens', 'Status']}>
          {filteredSessions.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '')).map((row) => <tr key={row.id} onClick={() => void openDetail('session', row.id)} className="cursor-pointer hover:bg-slate-800/40"><td className="px-5 py-4"><div className="font-medium text-white">{row.displayName ?? 'Unnamed session'}</div><div className="mt-1 font-mono text-xs text-slate-500">{row.externalSessionId}</div></td><td className="px-5 py-4"><div>{row.agent}</div><div className="text-xs text-slate-500">{row.models.auditedValue.join(', ') || 'Unknown'} {row.models.corrected && <Badge tone="violet">corrected</Badge>}</div></td><td className="px-5 py-4 text-slate-400">{row.repositories.map((repo) => repo.name).join(', ') || '—'}</td><td className="px-5 py-4">{row.retainedCommitCount} / {row.historicalCommitCount}</td><td className="px-5 py-4">{compact(row.totalTokens)}</td><td className="px-5 py-4"><Badge tone={row.status === 'shipped' ? 'green' : 'amber'}>{row.status}</Badge></td></tr>)}</TableShell>}
        {view === 'commits' && <TableShell headers={['Commit', 'Repository', 'Author', 'Lifecycle', 'Sessions', 'Final AI', 'Human']}>
          {filteredCommits.sort((a, b) => (b.committedAt ?? '').localeCompare(a.committedAt ?? '')).map((row) => <tr key={row.id} onClick={() => void openDetail('commit', row.id)} className="cursor-pointer hover:bg-slate-800/40"><td className="px-5 py-4"><div className="font-medium text-white">{row.subject}</div><div className="mt-1 font-mono text-xs text-violet-400">{row.sha.slice(0, 9)}</div></td><td className="px-5 py-4 text-slate-400">{row.repository?.name ?? '—'}</td><td className="px-5 py-4 text-slate-400">{row.authorEmail ?? row.authorName ?? '—'}</td><td className="px-5 py-4"><Badge tone={row.reachability === 'superseded' || row.reachability === 'unreachable' ? 'amber' : row.reachability === 'pull_request' || row.reachability === 'reachable' ? 'green' : 'slate'}>{row.reachability === 'pull_request' ? 'active in PR' : row.reachability}</Badge><div className="mt-1 text-xs text-slate-500">{row.operationKind}</div></td><td className="px-5 py-4">{row.sessionCount}</td><td className="px-5 py-4">{row.finalAiLines.auditedValue} {row.finalAiLines.corrected && <Badge tone="violet">audited</Badge>}</td><td className="px-5 py-4">{row.finalHumanLines.auditedValue}</td></tr>)}</TableShell>}
        {view === 'pullRequests' && <TableShell headers={['Pull request', 'Repository', 'Author', 'Branch', 'State', 'Updated']}>
          {pullRequests.filter((row) => matches([row.title, row.authorEmail, row.authorLogin, row.headRef])).map((row) => <tr key={row.id} onClick={() => void openDetail('pullRequest', row.id)} className="cursor-pointer hover:bg-slate-800/40"><td className="px-5 py-4 font-medium text-white">{row.title}</td><td className="px-5 py-4 text-slate-400">{repositories.find((repo) => repo.id === row.repositoryId)?.name ?? '—'}</td><td className="px-5 py-4 text-slate-400">{row.authorLogin ?? row.authorEmail ?? '—'}</td><td className="px-5 py-4">{row.headRef ?? '—'}</td><td className="px-5 py-4"><Badge tone={row.state === 'open' ? 'green' : row.state === 'merged' ? 'violet' : 'slate'}>{row.state}</Badge></td><td className="px-5 py-4 text-slate-500">{date(row.updatedAt)}</td></tr>)}</TableShell>}
        {view === 'repositories' && <TableShell headers={['Repository', 'Provider', 'Canonical URL', 'External ID']}>
          {repositories.filter((row) => matches([row.name, row.url, row.provider])).map((row) => <tr key={row.id}><td className="px-5 py-4 font-medium text-white">{row.name}</td><td className="px-5 py-4">{row.provider}</td><td className="px-5 py-4 text-slate-400"><a href={row.url} target="_blank" rel="noreferrer" className="hover:text-violet-300">{row.normalizedUrl ?? row.url}</a></td><td className="px-5 py-4 text-slate-500">{row.externalId}</td></tr>)}</TableShell>}
        {view === 'contributors' && <TableShell headers={['Contributor', 'Email', 'Repository', 'Machine']}>
          {contributors.filter((row) => matches([row.name, row.email])).map((row) => <tr key={row.id}><td className="px-5 py-4 font-medium text-white">{row.name}</td><td className="px-5 py-4 text-slate-400">{row.email ?? 'Not provided by GitHub'}</td><td className="px-5 py-4">{repositories.find((repo) => repo.id === row.repositoryId)?.name ?? '—'}</td><td className="px-5 py-4 text-slate-500">{row.machineId ?? '—'}</td></tr>)}</TableShell>}
        {view === 'administration' && <AdminPanel context={adminContext} resources={adminResources} loading={adminLoading} error={adminError} onChanged={() => void refresh(false)} />}
      </section>
    </main>
    <DetailDrawer detail={detail} close={() => setDetail(null)} openLinked={(kind, id) => void openDetail(kind, id)} />
  </div>;
}
