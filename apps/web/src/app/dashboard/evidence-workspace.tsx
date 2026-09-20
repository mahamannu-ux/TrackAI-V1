'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  getEvidenceLineWhy,
  getEvidenceRaw,
  getEvidenceSettings,
  getEvidenceWorkStory,
  getEvidenceWorkspace,
  searchEvidenceWorkspace,
  type AdminContext,
  type EvidenceGraphNode,
  type EvidencePerspective,
  type EvidenceWorkCard,
  type EvidenceWorkStory,
  type EvidenceWorkspaceResponse,
  type EvidenceWorkspaceSearchFilters,
  type EvidenceWorkspaceSearchResult,
  type Repository,
  type TelemetryModel,
} from '@/lib/api';

function Badge({ children, tone = 'slate' }: {
  children: React.ReactNode; tone?: 'slate' | 'green' | 'amber' | 'violet' | 'rose';
}) {
  const styles = {
    slate: 'bg-slate-800 text-slate-300', green: 'bg-emerald-500/10 text-emerald-300',
    amber: 'bg-amber-500/10 text-amber-300', violet: 'bg-violet-500/10 text-violet-300',
    rose: 'bg-rose-500/10 text-rose-300',
  };
  return <span className={`rounded-full px-2.5 py-1 text-xs ${styles[tone]}`}>{children}</span>;
}

function tone(value: string): 'slate' | 'green' | 'amber' | 'violet' | 'rose' {
  if (value === 'recorded' || value === 'observed' || value === 'deployed') return 'green';
  if (value === 'corrected' || value === 'merged') return 'violet';
  if (value === 'unavailable' || value === 'failed' || value === 'closed') return 'rose';
  if (value === 'partial' || value === 'inferred' || value === 'open') return 'amber';
  return 'slate';
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value));
}

function matchReason(reason: string) {
  const labels: Record<string, string> = {
    exact_phrase: 'Exact intention phrase',
    lexical: 'Shared terms',
    semantic: 'Similar intention',
    semantic_concept_expansion: 'Concurrency concept match',
    exact_intention: 'Exact intention',
    commit: 'Commit match',
    file_path: 'File match',
    evidence_metadata: 'Evidence metadata match',
  };
  return labels[reason] ?? reason.replaceAll('_', ' ');
}

const perspectiveCopy: Record<EvidencePerspective, { label: string; description: string }> = {
  leader: { label: 'Leader', description: 'Outcomes, intentions and workflow insights' },
  developer: { label: 'Developer', description: 'Changes, tests and code provenance' },
  security: { label: 'Security', description: 'Evidence quality, gaps and authorized access' },
};

function WorkCard({ card, selected, onSelect }: {
  card: EvidenceWorkCard & { matchReasons?: string[] }; selected: boolean; onSelect: () => void;
}) {
  return <button onClick={onSelect} className={`w-full rounded-xl border p-4 text-left transition ${
    selected ? 'border-violet-500/60 bg-violet-500/10' : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
  }`}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><div className="truncate font-medium text-white">{card.title}</div><div className="mt-1 text-xs text-slate-500">{card.repository?.name ?? 'Repository unavailable'}{card.branch ? ` · ${card.branch}` : ''}</div></div>
      <Badge tone={tone(card.outcome)}>{card.outcome.replace('_', ' ')}</Badge>
    </div>
    <div className="mt-3 line-clamp-2 text-sm text-slate-300">{card.intention.text ?? 'No available intention'}</div>
    {card.matchReasons && card.matchReasons.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{card.matchReasons.map(reason => <Badge key={reason}>{matchReason(reason)}</Badge>)}</div>}
    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500"><span>{card.counts.commits} commit{card.counts.commits === 1 ? '' : 's'}</span><span>·</span><span>{card.counts.reworkedLines} reworked lines</span><span>·</span><span>{shortDate(card.updatedAt)}</span></div>
  </button>;
}

function Quality({ quality }: { quality: EvidenceWorkCard['evidenceQuality'] }) {
  return <div className="flex flex-wrap gap-2">
    {Object.entries(quality).map(([label, value]) => <Badge key={label} tone={tone(value)}>{label.replace(/([A-Z])/g, ' $1')}: {value}</Badge>)}
  </div>;
}

function Summary({ story }: { story: EvidenceWorkStory }) {
  return <div className="grid gap-3 xl:grid-cols-4">
    <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4"><div className="text-xs uppercase tracking-wider text-violet-300">Why</div><div className="mt-2 text-sm text-white">{story.summary.why.primary ?? 'No available intention'}</div><div className="mt-2 flex gap-2">{story.summary.why.state && <Badge tone={tone(story.summary.why.state)}>{story.summary.why.state}</Badge>}{story.summary.why.additional > 0 && <Badge>+{story.summary.why.additional} more</Badge>}</div></div>
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div className="text-xs uppercase tracking-wider text-slate-500">Outcome</div><div className="mt-2 text-base font-medium text-white">{story.summary.outcome.label}</div><div className="mt-2"><Badge tone={tone(story.summary.outcome.status)}>{story.summary.outcome.status.replace('_', ' ')}</Badge></div></div>
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div className="text-xs uppercase tracking-wider text-slate-500">Key insight</div><div className="mt-2 text-sm text-slate-200">{story.summary.keyInsight}</div></div>
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div className="text-xs uppercase tracking-wider text-slate-500">Evidence quality</div><div className="mt-3"><Quality quality={story.summary.evidenceQuality}/></div></div>
  </div>;
}

function TreeButton({ selected, onClick, children }: {
  selected: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return <button role="treeitem" aria-selected={selected} onClick={onClick} className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${selected ? 'bg-violet-500/15 text-violet-200' : 'text-slate-400 hover:bg-slate-800/70 hover:text-white'}`}>{children}</button>;
}

function StoryTree({ story, perspective, selected, onSelect }: {
  story: EvidenceWorkStory; perspective: EvidencePerspective; selected: string; onSelect: (value: string) => void;
}) {
  const changesOpen = perspective === 'developer';
  const insightsOpen = perspective !== 'leader';
  const evidenceOpen = perspective === 'security';
  const relatedToSession = (sessionId: string) => {
    const directlyLinked = new Set(story.graph.edges.filter(edge => edge.toType === 'session'
      && edge.toId === sessionId).map(edge => `${edge.fromType}:${edge.fromId}`));
    const traceIds = new Set(story.graph.edges.filter(edge => directlyLinked.has(`${edge.fromType}:${edge.fromId}`)
      && edge.toType === 'trace').map(edge => edge.toId));
    return story.graph.nodes.filter(node => directlyLinked.has(`${node.type}:${node.id}`)
      || (node.type === 'trace' && traceIds.has(node.id)));
  };
  return <div role="tree" aria-label="Evidence story" className="space-y-2">
    <TreeButton selected={selected === 'overview'} onClick={() => onSelect('overview')}>Overview</TreeButton>
    <details open={perspective === 'leader'}><summary className="cursor-pointer py-1 text-sm font-medium text-slate-300">Intentions ({story.intentions.length})</summary><div role="group" className="ml-3 space-y-1 border-l border-slate-800 pl-2">{story.intentions.length ? story.intentions.map(item => <TreeButton key={item.id} selected={selected === `intention:${item.id}`} onClick={() => onSelect(`intention:${item.id}`)}>{item.text}</TreeButton>) : <div className="px-2 py-1 text-xs text-slate-600">Unavailable</div>}</div></details>
    <details open={perspective === 'leader'}><summary className="cursor-pointer py-1 text-sm font-medium text-slate-300">Outcome and lifecycle</summary><div role="group" className="ml-3 space-y-1 border-l border-slate-800 pl-2"><TreeButton selected={selected === 'lifecycle'} onClick={() => onSelect('lifecycle')}>PR, merge and deployment</TreeButton>{story.changes.map(commit => <TreeButton key={commit.id} selected={selected === `commit:${commit.id}`} onClick={() => onSelect(`commit:${commit.id}`)}>{commit.sha.slice(0, 8)} {commit.historical ? '(historical)' : ''}</TreeButton>)}</div></details>
    <details open={changesOpen}><summary className="cursor-pointer py-1 text-sm font-medium text-slate-300">Changes ({story.changes.reduce((sum, commit) => sum + commit.files.length, 0)} files)</summary><div role="group" className="ml-3 space-y-1 border-l border-slate-800 pl-2">{story.changes.map(commit => <details key={commit.id}><summary className="cursor-pointer py-1 text-xs text-slate-500">{commit.sha.slice(0, 8)} · {commit.subject}</summary><div className="ml-3 space-y-1 border-l border-slate-800 pl-2">{commit.files.map(file => <TreeButton key={file.id} selected={selected === `file:${commit.id}:${file.id}`} onClick={() => onSelect(`file:${commit.id}:${file.id}`)}>{file.path}</TreeButton>)}</div></details>)}</div></details>
    <details open={insightsOpen}><summary className="cursor-pointer py-1 text-sm font-medium text-slate-300">Insights</summary><div role="group" className="ml-3 border-l border-slate-800 pl-2"><TreeButton selected={selected === 'insights'} onClick={() => onSelect('insights')}>Friction, tests and gaps</TreeButton></div></details>
    <details open={evidenceOpen}><summary className="cursor-pointer py-1 text-sm font-medium text-slate-300">Evidence details</summary><div role="group" className="ml-3 space-y-1 border-l border-slate-800 pl-2">{story.graph.nodes.filter(node => node.type === 'session').map(node => <details key={node.id}><summary className="cursor-pointer px-2 py-1 text-xs text-slate-500">{node.label}</summary><div className="ml-3 space-y-1 border-l border-slate-800 pl-2">{relatedToSession(node.id).filter(item => item.type === 'checkpoint' || item.type === 'trace').map(item => <TreeButton key={`${node.id}:${item.type}:${item.id}`} selected={selected === `evidence:${item.type}:${item.id}`} onClick={() => onSelect(`evidence:${item.type}:${item.id}`)}>{item.label}</TreeButton>)}{relatedToSession(node.id).filter(item => item.type === 'event').map(item => <TreeButton key={item.id} selected={selected === `event:${item.id}`} onClick={() => onSelect(`event:${item.id}`)}>{item.label}</TreeButton>)}</div></details>)}</div></details>
  </div>;
}

function DetailPane({ story, selected, canReadRaw, onLineWhy }: {
  story: EvidenceWorkStory; selected: string; canReadRaw: boolean;
  onLineWhy: (commitId: string, path: string, line: number) => Promise<void>;
}) {
  const [line, setLine] = useState('');
  const [raw, setRaw] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRaw(null); setLine(''); }, [selected]);
  const intention = selected.startsWith('intention:')
    ? story.intentions.find(item => item.id === selected.slice('intention:'.length)) : null;
  const commit = selected.startsWith('commit:')
    ? story.changes.find(item => item.id === selected.slice('commit:'.length)) : null;
  const fileParts = selected.startsWith('file:') ? selected.split(':') : null;
  const fileCommit = fileParts ? story.changes.find(item => item.id === fileParts[1]) : null;
  const file = fileCommit?.files.find(item => item.id === fileParts?.[2]);
  const event = selected.startsWith('event:')
    ? story.graph.nodes.find(item => item.type === 'event' && item.id === selected.slice('event:'.length)) : null;
  const evidence = selected.startsWith('evidence:')
    ? story.graph.nodes.find(item => `${item.type}:${item.id}` === selected.slice('evidence:'.length)) : null;

  if (selected === 'overview') return <div className="space-y-5"><div><h3 className="text-lg font-semibold text-white">Work story</h3><p className="mt-2 text-sm text-slate-400">{story.summary.why.primary ?? 'The available evidence does not contain an intention.'}</p></div>{story.similarWork.items.length > 0 && <section><h4 className="text-sm font-medium text-white">Similar work</h4><div className="mt-3 space-y-2">{story.similarWork.items.map(item => <div key={`${item.kind}:${item.id}`} className="rounded-lg border border-slate-800 p-3"><div className="flex justify-between gap-3"><div className="text-sm text-slate-200">{item.title}</div><Badge tone={tone(item.outcome)}>{item.outcome}</Badge></div><div className="mt-2 flex flex-wrap gap-1.5">{item.matchReasons.map(reason => <Badge key={reason}>{matchReason(reason)}</Badge>)}</div><div className="mt-2 text-xs text-slate-500">{item.keyInsight}</div></div>)}</div></section>} {story.similarWork.status === 'unavailable' && <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">Similar-work search is unavailable until the local semantic model is ready.</div>}</div>;
  if (intention) return <div><div className="flex gap-2"><Badge tone={tone(intention.state)}>{intention.state}</Badge><Badge>{intention.confidence}% confidence</Badge><Badge>{intention.lifecycle}</Badge></div><h3 className="mt-4 text-lg font-semibold text-white">Intention</h3><p className="mt-2 text-slate-300">{intention.text}</p><p className="mt-4 text-xs text-slate-500">An intention is a customer goal. It remains separate from the original prompt and may relate to several commits.</p></div>;
  if (selected === 'lifecycle') return <div className="space-y-5"><div><h3 className="text-lg font-semibold text-white">Outcome and lifecycle</h3><p className="mt-2 text-sm text-slate-400">{story.summary.outcome.label}</p></div>{story.lifecycle.pullRequest && <div className="rounded-lg border border-slate-800 p-3 text-sm"><div className="text-white">{story.lifecycle.pullRequest.title}</div><div className="mt-1 text-slate-500">{story.lifecycle.pullRequest.headRef ?? 'unknown branch'} → {story.lifecycle.pullRequest.baseRef ?? 'unknown base'} · {story.lifecycle.pullRequest.state}</div></div>}{story.lifecycle.merge && <div className="rounded-lg border border-slate-800 p-3 text-sm text-slate-300">Merge commit <span className="font-mono text-violet-300">{story.lifecycle.merge.sha.slice(0, 12)}</span></div>}{story.lifecycle.deployments.length ? story.lifecycle.deployments.map(item => <div key={item.id} className="rounded-lg border border-emerald-500/20 p-3 text-sm"><div className="text-emerald-200">{item.environment} · {item.status}</div><div className="mt-1 text-xs text-slate-500">{shortDate(item.deployedAt)}{item.production ? ' · production' : ''}</div></div>) : <div className="text-sm text-slate-500">No deployment is observed for this work.</div>}</div>;
  if (commit) return <div><h3 className="text-lg font-semibold text-white">{commit.subject}</h3><div className="mt-2 font-mono text-sm text-violet-300">{commit.sha}</div><div className="mt-4 text-sm text-slate-400">{commit.files.length} changed file{commit.files.length === 1 ? '' : 's'}{commit.historical ? ' · removed from the current PR' : ''}</div></div>;
  if (file && fileCommit) return <div className="space-y-5"><div><h3 className="break-all text-lg font-semibold text-white">{file.path}</h3><div className="mt-2 text-sm text-slate-400">{file.aiLines} AI-attributed · {file.humanLines} human-attributed · {file.unknownLines} unknown lines</div></div><div><div className="text-xs uppercase tracking-wider text-slate-500">Why does a line exist?</div><div className="mt-2 flex gap-2"><input aria-label="Line number" type="number" min="1" value={line} onChange={eventValue => setLine(eventValue.target.value)} placeholder="Line number" className="w-40 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"/><button disabled={!Number.isInteger(Number(line)) || Number(line) < 1 || busy} onClick={() => { setBusy(true); void onLineWhy(fileCommit.id, file.path, Number(line)).finally(() => setBusy(false)); }} className="rounded-lg bg-violet-600 px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Tracing…' : 'Explain line'}</button></div></div><section><h4 className="text-sm font-medium text-white">Attributed ranges</h4><div className="mt-2 space-y-2">{file.ranges.length ? file.ranges.map((range, index) => <div key={index} className="rounded-lg border border-slate-800 p-3 font-mono text-xs text-slate-400">Lines {String(range.startLine ?? '?')}–{String(range.endLine ?? '?')} · trace {String(range.traceId ?? 'unavailable')}</div>) : <div className="text-sm text-amber-200">No exact GitAI range attribution is available.</div>}</div></section>{story.focus && <div className={`rounded-lg border p-3 text-sm ${story.focus.attribution === 'exact' ? 'border-emerald-500/20 text-emerald-200' : 'border-amber-500/20 text-amber-200'}`}>Line {story.focus.line}: {story.focus.attribution === 'exact' ? `exact GitAI attribution through ${story.focus.traceIds.length} trace reference(s)` : 'no exact attribution; TrackAI will not present time proximity as proof'}</div>}</div>;
  if (selected === 'insights') return <div className="space-y-5"><div><h3 className="text-lg font-semibold text-white">Workflow insights</h3><p className="mt-1 text-xs text-slate-500">System and process signals only—not employee scoring.</p></div><div className="grid grid-cols-2 gap-3">{[['Failed tools', story.insights.failedTools], ['Retries', story.insights.retries], ['Slow tools', story.insights.slowTools], ['Prompt loops', story.insights.promptLoops], ['Reworked lines', story.insights.reworkedLines], ['Evidence gaps', story.insights.evidenceGaps]].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-slate-800 p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-xl text-white">{value}</div></div>)}</div><section><h4 className="text-sm font-medium text-white">Tests observed</h4><div className="mt-2 space-y-2">{story.insights.tests.length ? story.insights.tests.map(test => <div key={test.eventId} className="flex justify-between rounded-lg border border-slate-800 p-3 text-sm"><span>{test.label}</span><Badge tone={tone(test.status)}>{test.status}</Badge></div>) : <div className="text-sm text-slate-500">No test command could be identified from available tool evidence.</div>}</div></section>{story.insights.unresolved.length > 0 && <section><h4 className="text-sm font-medium text-white">Unresolved signals</h4><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-200">{story.insights.unresolved.map(item => <li key={item}>{item}</li>)}</ul></section>}</div>;
  if (event) return <div className="space-y-4"><div><h3 className="text-lg font-semibold text-white">{event.label}</h3><div className="mt-2 flex gap-2"><Badge tone={tone(event.evidenceState)}>{event.evidenceState}</Badge><Badge tone={tone(event.availability)}>{event.availability}</Badge></div></div><div className="rounded-lg border border-slate-800 p-3 text-sm text-slate-400">{event.occurredAt ? shortDate(event.occurredAt) : 'Time unavailable'} · {String(event.data?.model ?? 'model unavailable')}</div>{canReadRaw && event.availability !== 'unavailable' && event.availability !== 'expired' && <button onClick={() => { setBusy(true); void getEvidenceRaw(event.id).then(setRaw).finally(() => setBusy(false)); }} className="rounded-lg border border-violet-500/40 px-3 py-2 text-sm text-violet-200">{busy ? 'Opening…' : 'Open authorized raw evidence'}</button>}{raw && <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs text-slate-300">{JSON.stringify(raw, null, 2)}</pre>}{!canReadRaw && <div className="text-sm text-slate-500">Raw evidence requires approved administrator or security access.</div>}</div>;
  if (evidence) return <div><h3 className="text-lg font-semibold text-white">{evidence.label}</h3><div className="mt-3 flex gap-2"><Badge tone={tone(evidence.evidenceState)}>{evidence.evidenceState}</Badge><Badge tone={tone(evidence.availability)}>{evidence.availability}</Badge></div><pre className="mt-4 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs text-slate-400">{JSON.stringify(evidence.data ?? {}, null, 2)}</pre></div>;
  return <div className="text-sm text-slate-500">Select an item from the evidence tree.</div>;
}

export function EvidenceWorkspace({ repositories, models, adminContext }: {
  repositories: Repository[]; models: TelemetryModel[]; adminContext: AdminContext | null;
}) {
  const [perspective, setPerspective] = useState<EvidencePerspective>('leader');
  const [workspace, setWorkspace] = useState<EvidenceWorkspaceResponse | null>(null);
  const [selectedCard, setSelectedCard] = useState<EvidenceWorkCard | null>(null);
  const [story, setStory] = useState<EvidenceWorkStory | null>(null);
  const [selectedNode, setSelectedNode] = useState('overview');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<EvidenceWorkspaceSearchResult[]>([]);
  const [filters, setFilters] = useState<EvidenceWorkspaceSearchFilters>({});
  const [loading, setLoading] = useState(true);
  const [storyLoading, setStoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collection, setCollection] = useState<{ enabled: boolean; retention: number } | null>(null);
  const canReadRaw = adminContext?.membership?.status === 'active';

  function updateUrl(card: EvidenceWorkCard | null, lens = perspective, focus?: { path: string; line: number }) {
    const parameters = new URLSearchParams(window.location.search);
    parameters.set('lens', lens);
    if (card) { parameters.set('workType', card.kind); parameters.set('workId', card.id); }
    else { parameters.delete('workType'); parameters.delete('workId'); }
    if (focus) { parameters.set('path', focus.path); parameters.set('line', String(focus.line)); }
    else { parameters.delete('path'); parameters.delete('line'); }
    window.history.replaceState(null, '', `${window.location.pathname}?${parameters.toString()}`);
  }

  async function openCard(card: EvidenceWorkCard, restoreFocus?: { path: string; line: number }) {
    setSelectedCard(card); setStoryLoading(true); setError(null); setSelectedNode('overview');
    try {
      const value = restoreFocus && card.kind === 'direct_commit'
        ? await getEvidenceLineWhy(card.id, restoreFocus.path, restoreFocus.line)
        : await getEvidenceWorkStory(card.kind, card.id);
      setStory(value); updateUrl(card, perspective, restoreFocus);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Evidence story unavailable'); }
    finally { setStoryLoading(false); }
  }

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const requested = parameters.get('lens');
    const saved = window.localStorage.getItem('trackai-evidence-perspective');
    const lens = (requested ?? saved) as EvidencePerspective | null;
    if (lens && perspectiveCopy[lens]) setPerspective(lens);
    void getEvidenceWorkspace().then(async value => {
      setWorkspace(value);
      const type = parameters.get('workType'); const id = parameters.get('workId');
      const all = [...value.pullRequests.items, ...value.directChanges.items, ...value.unfinishedWork.items];
      const requestedCard = all.find(item => item.kind === type && item.id === id);
      if (requestedCard) {
        const path = parameters.get('path'); const line = Number(parameters.get('line'));
        await openCard(requestedCard, path && Number.isInteger(line) && line > 0 ? { path, line } : undefined);
      }
    }).catch(cause => setError(cause instanceof Error ? cause.message : 'Workspace unavailable'))
      .finally(() => setLoading(false));
    if (canReadRaw) void getEvidenceSettings().then(value => setCollection({ enabled: value.rawCollectionEnabled, retention: value.retentionDays })).catch(() => setCollection(null));
    // Initial state is intentionally read once; story selection updates state directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReadRaw]);

  function choosePerspective(value: EvidencePerspective) {
    setPerspective(value); window.localStorage.setItem('trackai-evidence-perspective', value);
    updateUrl(selectedCard, value, story?.focus ? { path: story.focus.path, line: story.focus.line } : undefined);
    setSelectedNode(value === 'leader' ? 'overview' : value === 'developer' ? 'insights' : 'lifecycle');
  }

  async function runSearch() {
    if (query.trim().length < 2) return;
    setLoading(true); setError(null);
    try { setSearchResults((await searchEvidenceWorkspace(query.trim(), filters)).results); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Search unavailable'); }
    finally { setLoading(false); }
  }

  const insightCards = useMemo(() => {
    if (!workspace) return [];
    if (perspective === 'leader') return [
      ['Outcomes', workspace.insights.outcomes], ['Needs attention', String(workspace.insights.attention)],
      ['Evidence gaps', String(workspace.insights.evidenceGaps)],
    ];
    if (perspective === 'developer') return [
      ['Active PR stories', String(workspace.pullRequests.total)], ['Direct changes', String(workspace.directChanges.total)],
      ['Unfinished work', String(workspace.unfinishedWork.total)],
    ];
    return [
      ['Evidence gaps', String(workspace.insights.evidenceGaps)],
      ['Raw collection', collection ? collection.enabled ? 'Enabled' : 'Disabled' : 'Restricted'],
      ['Raw retention', collection ? `${collection.retention} days` : 'Restricted'],
    ];
  }, [workspace, perspective, collection]);

  const displayed = searchResults.length ? searchResults : workspace?.pullRequests.items ?? [];
  return <div className="space-y-6">
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div><div className="text-xs uppercase tracking-wider text-slate-500">Perspective</div><div className="mt-1 text-sm text-slate-300">{perspectiveCopy[perspective].description}</div></div>
      <div className="flex rounded-lg border border-slate-700 p-1" aria-label="Customer perspective">{(Object.keys(perspectiveCopy) as EvidencePerspective[]).map(value => <button key={value} aria-pressed={perspective === value} onClick={() => choosePerspective(value)} className={`rounded-md px-3 py-2 text-sm ${perspective === value ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}>{perspectiveCopy[value].label}</button>)}</div>
    </section>
    <section className="grid gap-3 md:grid-cols-3">{insightCards.map(([label, value]) => <div key={label} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><div className="text-xs uppercase tracking-wider text-slate-500">{label}</div><div className="mt-2 text-xl font-semibold text-white">{value}</div></div>)}</section>
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex gap-2"><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void runSearch(); }} placeholder="Find a PR, intention, commit SHA, file, tool or error…" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"/><button onClick={() => void runSearch()} className="rounded-lg bg-violet-600 px-4 py-2 text-sm text-white">Find or investigate</button>{searchResults.length > 0 && <button onClick={() => { setSearchResults([]); setQuery(''); }} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">Clear</button>}</div>
      <details className="mt-3"><summary className="cursor-pointer text-xs text-slate-500">Filters</summary><div className="mt-3 grid gap-2 md:grid-cols-3 xl:grid-cols-8"><select value={filters.repositoryId ?? ''} onChange={event => setFilters(current => ({ ...current, repositoryId: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"><option value="">All repositories</option>{repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.name}</option>)}</select><input value={filters.branch ?? ''} onChange={event => setFilters(current => ({ ...current, branch: event.target.value }))} placeholder="Branch" className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"/><select value={filters.agent ?? ''} onChange={event => setFilters(current => ({ ...current, agent: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"><option value="">All agents</option>{[...new Set(models.map(model => model.tool))].map(agent => <option key={agent} value={agent}>{agent}</option>)}</select><select value={filters.model ?? ''} onChange={event => setFilters(current => ({ ...current, model: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"><option value="">All models</option>{[...new Set(models.flatMap(model => model.model ? [model.model] : []))].map(model => <option key={model} value={model}>{model}</option>)}</select><select value={filters.outcome ?? ''} onChange={event => setFilters(current => ({ ...current, outcome: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"><option value="">All outcomes</option>{['open', 'merged', 'deployed', 'closed', 'direct_change', 'unfinished'].map(value => <option key={value} value={value}>{value.replace('_', ' ')}</option>)}</select><select value={filters.resultType ?? ''} onChange={event => setFilters(current => ({ ...current, resultType: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"><option value="">All work types</option><option value="pull_request">Pull requests</option><option value="direct_commit">Direct changes</option><option value="unfinished_intention">Unfinished work</option></select><input type="date" aria-label="From date" value={filters.from ?? ''} onChange={event => setFilters(current => ({ ...current, from: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"/><input type="date" aria-label="To date" value={filters.to ?? ''} onChange={event => setFilters(current => ({ ...current, to: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"/></div></details>
    </section>
    {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>}
    {loading && <div className="rounded-xl border border-slate-800 p-5 text-sm text-slate-500">Loading evidence workspace…</div>}
    {!loading && workspace && <div className="grid gap-5 xl:grid-cols-[minmax(280px,0.8fr),minmax(0,2.2fr)]">
      <aside className="space-y-4">
        <div><h2 className="font-semibold text-white">{searchResults.length ? 'Search results' : 'Pull request work'}</h2><p className="mt-1 text-xs text-slate-500">Start with customer outcomes; open the evidence only when needed.</p></div>
        <div className="space-y-2">{displayed.map(card => <WorkCard key={`${card.kind}:${card.id}`} card={card} selected={selectedCard?.kind === card.kind && selectedCard.id === card.id} onSelect={() => void openCard(card)}/>)}</div>
        {!searchResults.length && <><details><summary className="cursor-pointer rounded-lg border border-slate-800 p-3 text-sm text-slate-300">Direct changes ({workspace.directChanges.total})</summary><div className="mt-2 space-y-2">{workspace.directChanges.items.map(card => <WorkCard key={card.id} card={card} selected={selectedCard?.id === card.id} onSelect={() => void openCard(card)}/>)}</div></details><details><summary className="cursor-pointer rounded-lg border border-slate-800 p-3 text-sm text-slate-300">Unfinished work ({workspace.unfinishedWork.total})</summary><div className="mt-2 space-y-2">{workspace.unfinishedWork.items.map(card => <WorkCard key={card.id} card={card} selected={selectedCard?.id === card.id} onSelect={() => void openCard(card)}/>)}</div></details></>}
      </aside>
      <main className="min-w-0">
        {storyLoading && <div className="rounded-xl border border-slate-800 p-6 text-slate-500">Building the customer evidence story…</div>}
        {!storyLoading && !story && <div className="rounded-xl border border-dashed border-slate-700 p-10 text-center"><h2 className="text-lg font-medium text-white">Choose work to investigate</h2><p className="mt-2 text-sm text-slate-500">Select a PR, direct change, unfinished intention or search result.</p></div>}
        {!storyLoading && story && <div className="space-y-5"><div><div className="text-xs text-violet-300">{story.root.repository ?? 'Repository unavailable'}{story.root.branch ? ` / ${story.root.branch}` : ''}</div><h2 className="mt-1 text-2xl font-semibold text-white">{story.root.title}</h2></div><Summary story={story}/><div className="grid min-h-[32rem] gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4 lg:grid-cols-[minmax(220px,0.7fr),minmax(0,1.7fr)]"><aside className="border-b border-slate-800 pb-4 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4"><StoryTree key={`${story.root.type}:${story.root.id}:${perspective}`} story={story} perspective={perspective} selected={selectedNode} onSelect={setSelectedNode}/></aside><section className="min-w-0 p-2"><DetailPane story={story} selected={selectedNode} canReadRaw={Boolean(canReadRaw)} onLineWhy={async (commitId, path, lineNumber) => { const value = await getEvidenceLineWhy(commitId, path, lineNumber); setStory(value); setSelectedNode(`file:${commitId}:${value.changes.find(change => change.id === commitId)?.files.find(item => item.path === path)?.id ?? ''}`); updateUrl({ kind: 'direct_commit', id: commitId, title: value.root.title, repository: null, branch: value.root.branch, outcome: value.summary.outcome.status, updatedAt: new Date().toISOString(), intention: { text: value.summary.why.primary, count: value.intentions.length, state: value.summary.why.state }, keyInsight: value.summary.keyInsight, evidenceQuality: value.summary.evidenceQuality, counts: { commits: value.changes.length, reworkedLines: value.insights.reworkedLines, evidenceGaps: value.insights.evidenceGaps } }, perspective, { path, line: lineNumber }); }}/></section></div></div>}
      </main>
    </div>}
  </div>;
}
