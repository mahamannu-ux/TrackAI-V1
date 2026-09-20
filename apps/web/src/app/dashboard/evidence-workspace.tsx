'use client';

import { useEffect, useRef, useState } from 'react';
import {
  getEvidenceRaw,
  getEvidenceStoryLineWhy,
  getEvidenceWorkStory,
  getEvidenceWorkspace,
  searchEvidenceWorkspace,
  type AdminContext,
  type EvidenceGraphNode,
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

function outcomeLabel(value: EvidenceWorkCard['outcome']) {
  if (value === 'direct_change') return 'Committed, not in a PR';
  if (value === 'unfinished') return 'Not committed';
  return value.replace('_', ' ');
}

function WorkCard({ card, selected, onSelect }: {
  card: EvidenceWorkCard & { matchReasons?: string[] }; selected: boolean; onSelect: () => void;
}) {
  return <button onClick={onSelect} className={`w-full rounded-xl border p-4 text-left transition ${
    selected ? 'border-violet-500/60 bg-violet-500/10' : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
  }`}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><div className="truncate font-medium text-white">{card.title}</div><div className="mt-1 text-xs text-slate-500">{card.repository?.name ?? 'Repository unavailable'}{card.branch ? ` · ${card.branch}` : ''}</div></div>
      <Badge tone={tone(card.outcome)}>{outcomeLabel(card.outcome)}</Badge>
    </div>
    <div className="mt-3 line-clamp-2 text-sm text-slate-300">{card.intention.text ?? 'No available intention'}</div>
    {card.matchReasons && card.matchReasons.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{card.matchReasons.map(reason => <Badge key={reason}>{matchReason(reason)}</Badge>)}</div>}
    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500"><span>{card.counts.commits} commit{card.counts.commits === 1 ? '' : 's'}</span><span>·</span><span>{card.counts.reworkedLines} reworked lines</span><span>·</span><span>{shortDate(card.updatedAt)}</span></div>
  </button>;
}

function intentionSource(state: EvidenceWorkStory['summary']['why']['state']) {
  if (state === 'observed') return 'Explicitly provided';
  if (state === 'corrected') return 'Reviewed and corrected';
  if (state === 'inferred') return 'Derived from the first prompt — review recommended';
  return 'Source unavailable';
}

function coverageExplanation(label: string, value: string) {
  const subject = {
    attribution: 'Code attribution', intention: 'Intent', rawContent: 'Raw supporting evidence', lifecycle: 'Git lifecycle',
  }[label] ?? label;
  const meaning = value === 'recorded' ? 'TrackAI has the expected supporting record.'
    : value === 'partial' ? 'Some supporting evidence exists, but coverage is incomplete.'
      : 'TrackAI does not have supporting evidence for this part.';
  return { subject, meaning };
}

function TreeButton({ selected, onClick, children }: {
  selected: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return <button role="treeitem" aria-selected={selected} onClick={onClick} className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${selected ? 'bg-violet-500/15 text-violet-200' : 'text-slate-400 hover:bg-slate-800/70 hover:text-white'}`}>{children}</button>;
}

function StoryTree({ story, selected, onSelect }: {
  story: EvidenceWorkStory; selected: string; onSelect: (value: string) => void;
}) {
  const relatedToSession = (sessionId: string) => {
    const directlyLinked = new Set(story.graph.edges.filter(edge => edge.toType === 'session'
      && edge.toId === sessionId).map(edge => `${edge.fromType}:${edge.fromId}`));
    const traceIds = new Set(story.graph.edges.filter(edge => directlyLinked.has(`${edge.fromType}:${edge.fromId}`)
      && edge.toType === 'trace').map(edge => edge.toId));
    return story.graph.nodes.filter(node => directlyLinked.has(`${node.type}:${node.id}`)
      || (node.type === 'trace' && traceIds.has(node.id)));
  };
  return <div role="tree" aria-label="Evidence story" className="space-y-2">
    <TreeButton selected={selected === 'overview'} onClick={() => onSelect('overview')}>Summary</TreeButton>
    {story.intentions.length > 1 && <details><summary className="cursor-pointer py-1 text-sm font-medium text-slate-300">Related intents ({story.intentions.length})</summary><div role="group" className="ml-3 space-y-1 border-l border-slate-800 pl-2">{story.intentions.map(item => <TreeButton key={item.id} selected={selected === `intention:${item.id}`} onClick={() => onSelect(`intention:${item.id}`)}>{item.text}</TreeButton>)}</div></details>}
    <details><summary className="cursor-pointer py-1 text-sm font-medium text-slate-300">Outcome and lifecycle</summary><div role="group" className="ml-3 space-y-1 border-l border-slate-800 pl-2"><TreeButton selected={selected === 'lifecycle'} onClick={() => onSelect('lifecycle')}>PR, merge and deployment</TreeButton>{story.changes.map(commit => <TreeButton key={commit.id} selected={selected === `commit:${commit.id}`} onClick={() => onSelect(`commit:${commit.id}`)}>{commit.sha.slice(0, 8)} {commit.historical ? '(historical)' : ''}</TreeButton>)}</div></details>
    <details><summary className="cursor-pointer py-1 text-sm font-medium text-slate-300">Changes ({story.changes.reduce((sum, commit) => sum + commit.files.length, 0)} files)</summary><div role="group" className="ml-3 space-y-1 border-l border-slate-800 pl-2">{story.changes.map(commit => <details key={commit.id}><summary className="cursor-pointer py-1 text-xs text-slate-500">{commit.sha.slice(0, 8)} · {commit.subject}</summary><div className="ml-3 space-y-1 border-l border-slate-800 pl-2">{commit.files.map(file => <TreeButton key={file.id} selected={selected === `file:${commit.id}:${file.id}`} onClick={() => onSelect(`file:${commit.id}:${file.id}`)}>{file.path}</TreeButton>)}</div></details>)}</div></details>
    <details><summary className="cursor-pointer py-1 text-sm font-medium text-slate-300">Insights</summary><div role="group" className="ml-3 border-l border-slate-800 pl-2"><TreeButton selected={selected === 'insights'} onClick={() => onSelect('insights')}>Friction, tests and gaps</TreeButton></div></details>
    <details><summary className="cursor-pointer py-1 text-sm font-medium text-slate-300">How do we know?</summary><div role="group" className="ml-3 space-y-1 border-l border-slate-800 pl-2"><TreeButton selected={selected === 'evidence-quality'} onClick={() => onSelect('evidence-quality')}>Evidence coverage and sources</TreeButton>{story.graph.nodes.filter(node => node.type === 'session').map(node => <details key={node.id}><summary className="cursor-pointer px-2 py-1 text-xs text-slate-500">{node.label}</summary><div className="ml-3 space-y-1 border-l border-slate-800 pl-2">{relatedToSession(node.id).filter(item => item.type === 'checkpoint' || item.type === 'trace').map(item => <TreeButton key={`${node.id}:${item.type}:${item.id}`} selected={selected === `evidence:${item.type}:${item.id}`} onClick={() => onSelect(`evidence:${item.type}:${item.id}`)}>{item.label}</TreeButton>)}{relatedToSession(node.id).filter(item => item.type === 'event').map(item => <TreeButton key={item.id} selected={selected === `event:${item.id}`} onClick={() => onSelect(`event:${item.id}`)}>{item.label}</TreeButton>)}</div></details>)}</div></details>
  </div>;
}

function FileInvestigation({ story, commit, file, line, busy, onLineChange, onExplain, onSelectNode }: {
  story: EvidenceWorkStory;
  commit: EvidenceWorkStory['changes'][number];
  file: EvidenceWorkStory['changes'][number]['files'][number];
  line: string;
  busy: boolean;
  onLineChange: (value: string) => void;
  onExplain: (lineNumber: number) => Promise<void>;
  onSelectNode: (value: string) => void;
}) {
  const explain = (lineNumber: number) => void onExplain(lineNumber);
  return <div className="space-y-6">
    <div><h3 className="break-all text-lg font-semibold text-white">{file.path}</h3><div className="mt-2 text-sm text-slate-400">{file.aiLines} AI-attributed · {file.humanLines} human-attributed · {file.unknownLines} unknown lines</div></div>
    <section className="rounded-lg border border-slate-800 p-4"><h4 className="text-sm font-medium text-white">Investigate a line</h4><p className="mt-1 text-xs text-slate-500">Enter a line, or select a recorded range below. TrackAI will explain the intent first and keep technical provenance as supporting proof.</p><div className="mt-3 flex gap-2"><input aria-label="Line number" type="number" min="1" value={line} onChange={eventValue => onLineChange(eventValue.target.value)} placeholder="Line number" className="w-40 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"/><button disabled={!Number.isInteger(Number(line)) || Number(line) < 1 || busy} onClick={() => explain(Number(line))} className="rounded-lg bg-violet-600 px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Investigating…' : 'Explain line'}</button></div></section>
    {story.focus && <section className={`rounded-lg border p-4 ${story.focus.attribution === 'exact' ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}><div className="text-xs uppercase tracking-wider text-slate-500">Why line {story.focus.line} exists</div>{story.focus.attribution === 'exact' ? <><h4 className="mt-2 text-lg font-semibold text-white">{story.summary.why.primary ?? 'Intent unavailable'}</h4><div className="mt-4 grid gap-3 md:grid-cols-2"><div><div className="text-xs text-slate-500">Introduced through</div><div className="mt-1 text-sm text-slate-200">{commit.subject} · {commit.sha.slice(0, 12)}</div></div><div><div className="text-xs text-slate-500">Outcome</div><div className="mt-1 text-sm text-slate-200">{story.summary.outcome.label}</div></div></div><div className="mt-4 text-sm text-emerald-200">Exact GitAI attribution connects this line to {story.focus.traceIds.length} recorded trace{story.focus.traceIds.length === 1 ? '' : 's'}.</div><div className="mt-3 flex flex-wrap gap-2">{story.focus.traceIds.map(traceId => <button type="button" key={traceId} onClick={() => onSelectNode(`evidence:trace:${traceId}`)} className="rounded border border-emerald-500/30 px-2 py-1 font-mono text-xs text-emerald-200">Open supporting trace</button>)}</div></> : <><h4 className="mt-2 text-lg font-semibold text-white">TrackAI cannot explain this line with exact evidence.</h4><p className="mt-2 text-sm text-amber-100">The surrounding work has a recorded intent, but no GitAI range connects this specific line to it. TrackAI will not use time proximity as proof.</p></>}</section>}
    <details><summary className="cursor-pointer text-sm text-slate-400">Recorded attribution ranges ({file.ranges.length})</summary><div className="mt-2 space-y-2">{file.ranges.length ? file.ranges.map((range, index) => { const start = Number(range.startLine); const end = Number(range.endLine); const usable = Number.isInteger(start) && start > 0; return <button type="button" disabled={!usable || busy} onClick={() => usable && explain(start)} key={index} className="block w-full rounded-lg border border-slate-800 p-3 text-left text-xs text-slate-400 hover:border-violet-500/40 disabled:cursor-default"><span className="font-mono">Lines {Number.isInteger(start) ? start : '?'}–{Number.isInteger(end) ? end : '?'}</span>{usable && <span className="ml-2 text-violet-300">Explain this range</span>}</button>; }) : <div className="text-sm text-amber-200">No exact GitAI range attribution is available.</div>}</div></details>
  </div>;
}

function DetailPane({ story, selected, canReadRaw, onLineWhy, onSelectNode }: {
  story: EvidenceWorkStory; selected: string; canReadRaw: boolean;
  onLineWhy: (commitId: string, path: string, line: number) => Promise<void>;
  onSelectNode: (value: string) => void;
}) {
  const [line, setLine] = useState('');
  const [raw, setRaw] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [insightFilter, setInsightFilter] = useState<EvidenceWorkStory['insights']['signals'][number]['kind'] | null>(null);
  useEffect(() => { setRaw(null); setLine(''); setInsightFilter(null); }, [selected]);
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

  if (selected === 'overview') return <div className="space-y-6"><section><div className="text-xs uppercase tracking-wider text-violet-300">Intent</div><h3 className="mt-2 text-xl font-semibold text-white">{story.summary.why.primary ?? 'The intent is unavailable from the retained evidence.'}</h3>{story.summary.why.additional > 0 && <p className="mt-2 text-xs text-slate-500">This work also contains {story.summary.why.additional} related intent{story.summary.why.additional === 1 ? '' : 's'}.</p>}</section><section className="grid gap-3 md:grid-cols-3"><div className="rounded-lg border border-slate-800 p-3"><div className="text-xs text-slate-500">Outcome</div><div className="mt-2 text-sm text-white">{story.summary.outcome.label}</div></div><div className="rounded-lg border border-slate-800 p-3"><div className="text-xs text-slate-500">Scope</div><div className="mt-2 text-sm text-white">{story.changes.length} commit{story.changes.length === 1 ? '' : 's'} · {story.changes.reduce((total, change) => total + change.files.length, 0)} changed file{story.changes.reduce((total, change) => total + change.files.length, 0) === 1 ? '' : 's'}</div></div><div className="rounded-lg border border-slate-800 p-3"><div className="text-xs text-slate-500">Important signal</div><div className="mt-2 text-sm text-white">{story.summary.keyInsight}</div></div></section>{story.similarWork.items.length > 0 && <section><h4 className="text-sm font-medium text-white">Similar work</h4><div className="mt-3 space-y-2">{story.similarWork.items.map(item => <div key={`${item.kind}:${item.id}`} className="rounded-lg border border-slate-800 p-3"><div className="flex justify-between gap-3"><div className="text-sm text-slate-200">{item.title}</div><Badge tone={tone(item.outcome)}>{outcomeLabel(item.outcome)}</Badge></div><div className="mt-2 flex flex-wrap gap-1.5">{item.matchReasons.map(reason => <Badge key={reason}>{matchReason(reason)}</Badge>)}</div><div className="mt-2 text-xs text-slate-500">{item.keyInsight}</div></div>)}</div></section>}{story.similarWork.status === 'unavailable' && <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">Similar-work search is unavailable until the local semantic model is ready.</div>}</div>;
  if (intention) return <div className="space-y-4"><div><div className="text-xs uppercase tracking-wider text-violet-300">Related intent</div><h3 className="mt-2 text-lg font-semibold text-white">{intention.text}</h3></div><p className="text-sm text-slate-400">An intent is a goal associated with this work. It remains separate from the original prompt and may span several commits.</p><button type="button" onClick={() => onSelectNode('evidence-quality')} className="text-sm text-violet-300 hover:text-violet-200">See how TrackAI determined this →</button></div>;
  if (selected === 'evidence-quality') return <div className="space-y-5"><div><h3 className="text-lg font-semibold text-white">How do we know?</h3><p className="mt-1 text-sm text-slate-400">These details explain the source and limits of the story without changing its meaning.</p></div><div className="rounded-lg border border-slate-800 p-4"><div className="text-xs text-slate-500">Intent source</div><div className="mt-2 text-sm text-white">{intentionSource(story.summary.why.state)}</div></div><div className="space-y-2">{Object.entries(story.summary.evidenceQuality).map(([label, value]) => { const explanation = coverageExplanation(label, value); return <div key={label} className="rounded-lg border border-slate-800 p-3"><div className="flex items-center justify-between gap-3"><div className="text-sm text-white">{explanation.subject}</div><Badge tone={tone(value)}>{value}</Badge></div><p className="mt-2 text-xs text-slate-500">{explanation.meaning}</p></div>; })}</div><p className="text-xs text-slate-500">Open a session below this section only when you need the underlying prompts, tools, traces or checkpoints.</p></div>;
  if (selected === 'lifecycle') return <div className="space-y-5"><div><h3 className="text-lg font-semibold text-white">Outcome and lifecycle</h3><p className="mt-2 text-sm text-slate-400">{story.summary.outcome.label}</p></div>{story.lifecycle.pullRequest && <div className="rounded-lg border border-slate-800 p-3 text-sm"><div className="text-white">{story.lifecycle.pullRequest.title}</div><div className="mt-1 text-slate-500">{story.lifecycle.pullRequest.headRef ?? 'unknown branch'} → {story.lifecycle.pullRequest.baseRef ?? 'unknown base'} · {story.lifecycle.pullRequest.state}</div></div>}{story.lifecycle.merge && <div className="rounded-lg border border-slate-800 p-3 text-sm text-slate-300">Merge commit <span className="font-mono text-violet-300">{story.lifecycle.merge.sha.slice(0, 12)}</span></div>}{story.lifecycle.deployments.length ? story.lifecycle.deployments.map(item => <div key={item.id} className="rounded-lg border border-emerald-500/20 p-3 text-sm"><div className="text-emerald-200">{item.environment} · {item.status}</div><div className="mt-1 text-xs text-slate-500">{shortDate(item.deployedAt)}{item.production ? ' · production' : ''}</div></div>) : <div className="text-sm text-slate-500">No deployment is observed for this work.</div>}</div>;
  if (commit) return <div><h3 className="text-lg font-semibold text-white">{commit.subject}</h3><div className="mt-2 font-mono text-sm text-violet-300">{commit.sha}</div><div className="mt-4 text-sm text-slate-400">{commit.files.length} changed file{commit.files.length === 1 ? '' : 's'}{commit.historical ? ' · removed from the current PR' : ''}</div></div>;
  if (file && fileCommit) return <FileInvestigation story={story} commit={fileCommit} file={file} line={line} busy={busy} onLineChange={setLine} onSelectNode={onSelectNode} onExplain={async lineNumber => { setBusy(true); try { await onLineWhy(fileCommit.id, file.path, lineNumber); } finally { setBusy(false); } }}/>;
  if (selected === 'insights') {
    const metrics: Array<[string, number, EvidenceWorkStory['insights']['signals'][number]['kind'] | null]> = [
      ['Failed tools', story.insights.failedTools, 'failed_tool'],
      ['Retries', story.insights.retries, 'retry'],
      ['Slow tools', story.insights.slowTools, 'slow_tool'],
      ['Prompt loops', story.insights.promptLoops, 'prompt_loop'],
      ['Reworked lines', story.insights.reworkedLines, null],
      ['Evidence gaps', story.insights.evidenceGaps, 'evidence_gap'],
    ];
    const filteredSignals = insightFilter
      ? story.insights.signals.filter(signal => signal.kind === insightFilter) : [];
    return <div className="space-y-5"><div><h3 className="text-lg font-semibold text-white">Workflow insights</h3><p className="mt-1 text-xs text-slate-500">System and process signals only—not employee scoring. Select a supported total to inspect its evidence.</p></div><div className="grid grid-cols-2 gap-3">{metrics.map(([label, value, kind]) => {
      const hasDetails = Boolean(kind && story.insights.signals.some(signal => signal.kind === kind));
      return <button type="button" key={label} disabled={!hasDetails} aria-pressed={Boolean(kind && insightFilter === kind)} onClick={() => kind && setInsightFilter(current => current === kind ? null : kind)} className={`rounded-lg border p-3 text-left ${kind && insightFilter === kind ? 'border-violet-500/60 bg-violet-500/10' : 'border-slate-800'} ${hasDetails ? 'hover:border-violet-500/40' : 'cursor-default'}`}><div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-xl text-white">{value}</div>{hasDetails && <div className="mt-1 text-xs text-violet-300">Inspect evidence</div>}</button>;
    })}</div>{insightFilter && <section><h4 className="text-sm font-medium text-white">Supporting evidence</h4><div className="mt-2 space-y-2">{filteredSignals.map((signal, index) => <button type="button" key={`${signal.eventId}:${signal.kind}:${index}`} onClick={() => onSelectNode(`event:${signal.eventId}`)} className="flex w-full items-start justify-between gap-3 rounded-lg border border-slate-800 p-3 text-left text-sm hover:border-violet-500/40"><div><div className="text-slate-200">{signal.label}</div><div className="mt-1 text-xs text-slate-500">{signal.status ? `status ${signal.status}` : 'status unavailable'}{signal.attempt ? ` · attempt ${signal.attempt}` : ''}{signal.durationMs !== null ? ` · ${(signal.durationMs / 1000).toFixed(1)}s` : ''}</div></div><div className="flex flex-wrap justify-end gap-1"><Badge tone={tone(signal.evidenceState)}>{signal.evidenceState}</Badge><Badge tone={tone(signal.availability)}>{signal.availability}</Badge></div></button>)}</div></section>}<section><h4 className="text-sm font-medium text-white">Tests observed</h4><div className="mt-2 space-y-2">{story.insights.tests.length ? story.insights.tests.map(test => <button type="button" key={test.eventId} onClick={() => onSelectNode(`event:${test.eventId}`)} className="flex w-full justify-between rounded-lg border border-slate-800 p-3 text-left text-sm hover:border-violet-500/40"><span>{test.label}</span><Badge tone={tone(test.status)}>{test.status}</Badge></button>) : <div className="text-sm text-slate-500">No test command could be identified from available tool evidence.</div>}</div></section>{story.insights.unresolved.length > 0 && <section><h4 className="text-sm font-medium text-white">Unresolved signals</h4><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-200">{story.insights.unresolved.map(item => <li key={item}>{item}</li>)}</ul></section>}</div>;
  }
  if (event) return <div className="space-y-4"><div><h3 className="text-lg font-semibold text-white">{event.label}</h3><div className="mt-2 flex gap-2"><Badge tone={tone(event.evidenceState)}>{event.evidenceState}</Badge><Badge tone={tone(event.availability)}>{event.availability}</Badge></div></div><div className="rounded-lg border border-slate-800 p-3 text-sm text-slate-400">{event.occurredAt ? shortDate(event.occurredAt) : 'Time unavailable'} · {String(event.data?.model ?? 'model unavailable')}</div>{canReadRaw && event.availability !== 'unavailable' && event.availability !== 'expired' && <button onClick={() => { setBusy(true); void getEvidenceRaw(event.id).then(setRaw).finally(() => setBusy(false)); }} className="rounded-lg border border-violet-500/40 px-3 py-2 text-sm text-violet-200">{busy ? 'Opening…' : 'Open authorized raw evidence'}</button>}{raw && <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs text-slate-300">{JSON.stringify(raw, null, 2)}</pre>}{!canReadRaw && <div className="text-sm text-slate-500">Raw evidence requires approved administrator or security access.</div>}</div>;
  if (evidence) return <div><h3 className="text-lg font-semibold text-white">{evidence.label}</h3><div className="mt-3 flex gap-2"><Badge tone={tone(evidence.evidenceState)}>{evidence.evidenceState}</Badge><Badge tone={tone(evidence.availability)}>{evidence.availability}</Badge></div><pre className="mt-4 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs text-slate-400">{JSON.stringify(evidence.data ?? {}, null, 2)}</pre></div>;
  return <div className="text-sm text-slate-500">Select an item from the evidence tree.</div>;
}

export function EvidenceWorkspace({ repositories, models, adminContext }: {
  repositories: Repository[]; models: TelemetryModel[]; adminContext: AdminContext | null;
}) {
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
  const browseScrollPosition = useRef(0);
  const canReadRaw = adminContext?.membership?.status === 'active';

  function updateUrl(card: EvidenceWorkCard | null, focus?: { commitId: string; path: string; line: number }) {
    const parameters = new URLSearchParams(window.location.search);
    parameters.delete('lens');
    if (card) { parameters.set('workType', card.kind); parameters.set('workId', card.id); }
    else { parameters.delete('workType'); parameters.delete('workId'); }
    if (focus) { parameters.set('commitId', focus.commitId); parameters.set('path', focus.path); parameters.set('line', String(focus.line)); }
    else { parameters.delete('commitId'); parameters.delete('path'); parameters.delete('line'); }
    window.history.replaceState(null, '', `${window.location.pathname}?${parameters.toString()}`);
  }

  async function openCard(card: EvidenceWorkCard, restoreFocus?: { commitId: string; path: string; line: number }) {
    if (!story) browseScrollPosition.current = window.scrollY;
    setSelectedCard(card); setStoryLoading(true); setError(null); setSelectedNode('overview');
    try {
      const value = restoreFocus
        ? await getEvidenceStoryLineWhy(card.kind, card.id, restoreFocus.commitId, restoreFocus.path, restoreFocus.line)
        : await getEvidenceWorkStory(card.kind, card.id);
      setStory(value); updateUrl(card, restoreFocus);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Evidence story unavailable'); }
    finally { setStoryLoading(false); }
  }

  function selectStoryNode(value: string) {
    setSelectedNode(value);
    setStory(current => current?.focus ? { ...current, focus: null } : current);
    updateUrl(selectedCard);
  }

  function closeStory() {
    setStory(null); setSelectedCard(null); setSelectedNode('overview'); setError(null);
    updateUrl(null);
    window.requestAnimationFrame(() => window.scrollTo({ top: browseScrollPosition.current }));
  }

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    void getEvidenceWorkspace().then(async value => {
      setWorkspace(value);
      const type = parameters.get('workType'); const id = parameters.get('workId');
      const all = [...value.pullRequests.items, ...value.directChanges.items, ...value.unfinishedWork.items];
      const requestedCard = all.find(item => item.kind === type && item.id === id);
      if (requestedCard) {
        const requestedCommitId = parameters.get('commitId'); const path = parameters.get('path'); const line = Number(parameters.get('line'));
        const commitId = requestedCommitId ?? (requestedCard.kind === 'direct_commit' ? requestedCard.id : null);
        await openCard(requestedCard, commitId && path && Number.isInteger(line) && line > 0 ? { commitId, path, line } : undefined);
      }
    }).catch(cause => setError(cause instanceof Error ? cause.message : 'Workspace unavailable'))
      .finally(() => setLoading(false));
    // Initial state is intentionally read once; story selection updates state directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReadRaw]);

  async function runSearch() {
    if (query.trim().length < 2) return;
    setLoading(true); setError(null);
    try { setSearchResults((await searchEvidenceWorkspace(query.trim(), filters)).results); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Search unavailable'); }
    finally { setLoading(false); }
  }

  const displayed = searchResults.length ? searchResults : workspace?.pullRequests.items ?? [];
  return <div className="space-y-6">
    {!story && !storyLoading && <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex gap-2"><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void runSearch(); }} placeholder="Find a PR, intention, commit SHA, file, tool or error…" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"/><button onClick={() => void runSearch()} className="rounded-lg bg-violet-600 px-4 py-2 text-sm text-white">Find or investigate</button>{searchResults.length > 0 && <button onClick={() => { setSearchResults([]); setQuery(''); }} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">Clear</button>}</div>
      <details className="mt-3"><summary className="cursor-pointer text-xs text-slate-500">Filters</summary><div className="mt-3 grid gap-2 md:grid-cols-3 xl:grid-cols-8"><select value={filters.repositoryId ?? ''} onChange={event => setFilters(current => ({ ...current, repositoryId: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"><option value="">All repositories</option>{repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.name}</option>)}</select><input value={filters.branch ?? ''} onChange={event => setFilters(current => ({ ...current, branch: event.target.value }))} placeholder="Branch" className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"/><select value={filters.agent ?? ''} onChange={event => setFilters(current => ({ ...current, agent: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"><option value="">All agents</option>{[...new Set(models.map(model => model.tool))].map(agent => <option key={agent} value={agent}>{agent}</option>)}</select><select value={filters.model ?? ''} onChange={event => setFilters(current => ({ ...current, model: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"><option value="">All models</option>{[...new Set(models.flatMap(model => model.model ? [model.model] : []))].map(model => <option key={model} value={model}>{model}</option>)}</select><select value={filters.outcome ?? ''} onChange={event => setFilters(current => ({ ...current, outcome: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"><option value="">All outcomes</option>{['open', 'merged', 'deployed', 'closed', 'direct_change', 'unfinished'].map(value => <option key={value} value={value}>{value === 'direct_change' ? 'committed, not in a PR' : value === 'unfinished' ? 'not committed' : value.replace('_', ' ')}</option>)}</select><select value={filters.resultType ?? ''} onChange={event => setFilters(current => ({ ...current, resultType: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"><option value="">All work types</option><option value="pull_request">Pull requests</option><option value="direct_commit">Committed, not in a PR</option><option value="unfinished_intention">Not committed</option></select><input type="date" aria-label="From date" value={filters.from ?? ''} onChange={event => setFilters(current => ({ ...current, from: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"/><input type="date" aria-label="To date" value={filters.to ?? ''} onChange={event => setFilters(current => ({ ...current, to: event.target.value }))} className="rounded border border-slate-700 bg-slate-950 p-2 text-xs"/></div></details>
    </section>}
    {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>}
    {loading && <div className="rounded-xl border border-slate-800 p-5 text-sm text-slate-500">Loading evidence workspace…</div>}
    {!loading && workspace && !story && !storyLoading && <div className="space-y-4">
        <div><h2 className="font-semibold text-white">{searchResults.length ? 'Search results' : 'Pull request work'}</h2><p className="mt-1 text-xs text-slate-500">Start with customer outcomes; open the evidence only when needed.</p></div>
        <div className="grid gap-3 lg:grid-cols-2">{displayed.map(card => <WorkCard key={`${card.kind}:${card.id}`} card={card} selected={false} onSelect={() => void openCard(card)}/>)}</div>
        {!searchResults.length && <><details><summary className="cursor-pointer rounded-lg border border-slate-800 p-3 text-sm text-slate-300">Committed, not in a PR ({workspace.directChanges.total})</summary><div className="mt-2 grid gap-3 lg:grid-cols-2">{workspace.directChanges.items.map(card => <WorkCard key={card.id} card={card} selected={false} onSelect={() => void openCard(card)}/>)}</div></details><details><summary className="cursor-pointer rounded-lg border border-slate-800 p-3 text-sm text-slate-300">Not committed ({workspace.unfinishedWork.total})</summary><div className="mt-2 grid gap-3 lg:grid-cols-2">{workspace.unfinishedWork.items.map(card => <WorkCard key={card.id} card={card} selected={false} onSelect={() => void openCard(card)}/>)}</div></details></>}
    </div>}
    {storyLoading && <div className="rounded-xl border border-slate-800 p-6 text-slate-500">Building the customer evidence story…</div>}
    {!storyLoading && story && <main className="min-w-0 space-y-5">
      <button type="button" onClick={closeStory} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-slate-500 hover:text-white">← Back to evidence workspace</button>
      <div><div className="text-xs text-violet-300">{story.root.repository ?? 'Repository unavailable'}{story.root.branch ? ` / ${story.root.branch}` : ''}</div><h2 className="mt-1 text-2xl font-semibold text-white">{story.root.title}</h2></div>
      <div className="grid min-h-[32rem] gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4 lg:grid-cols-[minmax(220px,0.7fr),minmax(0,1.7fr)]">
        <aside className="border-b border-slate-800 pb-4 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4"><StoryTree key={`${story.root.type}:${story.root.id}`} story={story} selected={selectedNode} onSelect={selectStoryNode}/></aside>
        <section className="min-w-0 p-2"><DetailPane story={story} selected={selectedNode} canReadRaw={Boolean(canReadRaw)} onSelectNode={selectStoryNode} onLineWhy={async (commitId, path, lineNumber) => {
          if (!selectedCard) return;
          const value = await getEvidenceStoryLineWhy(selectedCard.kind, selectedCard.id, commitId, path, lineNumber);
          setStory(value);
          setSelectedNode(`file:${commitId}:${value.changes.find(change => change.id === commitId)?.files.find(item => item.path === path)?.id ?? ''}`);
          updateUrl(selectedCard, { commitId, path, line: lineNumber });
        }}/></section>
      </div>
    </main>}
  </div>;
}
