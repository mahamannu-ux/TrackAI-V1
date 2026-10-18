'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiProblemError,
  getQaAnswer,
  getQaQuestion,
  getQaQuestions,
  type QaAnswerQuery,
  type QaDimension,
  type QaDrilldownItem,
  type QaDrilldownPage,
  type QaEnvelope,
  type QaKind,
  type QaQuestion,
  type QaQuestionDetail,
  type QaQuestionId,
  type QaScopeLevel,
  type PullRequest,
  type Repository,
} from '@/lib/api';
import {
  Badge,
  availabilityLabel,
  availabilityTone,
  EvidenceLink,
  FigureCard,
  Field,
  QA_PROBLEM_MESSAGES,
  QA_WORDING_MESSAGES,
  QuestionGroup,
  ReasonPill,
} from './questions-presentation';
import { AttestaWorkspace } from './attesta-workspace';

const PERIODS = ['7', '30', '90', 'custom'] as const;
type Period = typeof PERIODS[number];

type Problem = { message: string; requestId: string | null; code: string | null };

function describeProblem(cause: unknown, fallback: string): Problem {
  if (cause instanceof ApiProblemError) {
    return {
      message: (cause.code && QA_PROBLEM_MESSAGES[cause.code]) || cause.code || cause.message || fallback,
      requestId: cause.requestId,
      code: cause.code,
    };
  }
  return {
    message: cause instanceof Error ? cause.message : fallback,
    requestId: null,
    code: null,
  };
}

function localInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
}

function localInputIso(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function isQuestionId(value: string | null): value is QaQuestionId {
  return Boolean(value && /^(Q|S)[1-9][0-9]{0,2}$/.test(value));
}

function isDimension(value: string | null): value is QaDimension {
  return Boolean(value && [
    'model', 'tool', 'repository', 'agent_family', 'operating_system',
    'rule', 'rule_category', 'severity', 'machine', 'team',
  ].includes(value));
}

function signedEvidenceReference(answer: QaEnvelope): string {
  if (answer.signed) return `Statement digest: ${answer.signed.statement_digest}`;
  if (!answer.signed_evidence) return 'Signed evidence reference';
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(answer.signed_evidence.query)) {
    if (value) parameters.set(key, value);
  }
  return `${answer.signed_evidence.path}?${parameters.toString()}`;
}

function scopeLabel(scope: QaScopeLevel): string {
  if (scope === 'pull_request') return 'Pull request';
  return scope === 'tenant' ? 'Entire tenant' : scope === 'commit' ? 'Commit' : 'Repository';
}

function buildQuery(input: {
  kind: QaKind;
  period: Period;
  customFrom: string;
  customTo: string;
  scope: QaScopeLevel;
  repositoryId: string;
  pullRequestId: string;
  commitSha: string;
  breakdown: QaDimension | '';
}): QaAnswerQuery | null {
  let from: string;
  let to: string;
  if (input.period === 'custom') {
    if (!input.customFrom || !input.customTo) return null;
    const fromTime = new Date(input.customFrom);
    const toTime = new Date(input.customTo);
    if (!Number.isFinite(fromTime.getTime()) || !Number.isFinite(toTime.getTime()) || fromTime > toTime) return null;
    from = fromTime.toISOString();
    to = toTime.toISOString();
  } else {
    to = new Date().toISOString();
    from = new Date(Date.now() - Number(input.period) * 24 * 60 * 60 * 1000).toISOString();
  }
  if (input.scope === 'repository' && !input.repositoryId) return null;
  if (input.scope === 'pull_request' && !input.pullRequestId) return null;
  if (input.scope === 'commit'
    && (!input.repositoryId || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.commitSha))) return null;
  return {
    kind: input.kind,
    from,
    to,
    ...(input.scope === 'repository' || input.scope === 'commit' ? { repository_id: input.repositoryId } : {}),
    ...(input.scope === 'pull_request' ? { pull_request_id: input.pullRequestId } : {}),
    ...(input.scope === 'commit' ? { commit_sha: input.commitSha } : {}),
    ...(input.breakdown ? { breakdown: input.breakdown } : {}),
  };
}

export function QuestionsWorkspace({ repositories, pullRequests, role }: {
  repositories: Repository[];
  pullRequests: PullRequest[];
  role: 'tenant_admin' | 'tenant_auditor';
}) {
  const isAuditor = role === 'tenant_auditor';
  const [questionList, setQuestionList] = useState<{ items: QaQuestion[]; version: number } | null>(null);
  const [questionListProblem, setQuestionListProblem] = useState<Problem | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedQuestionId, setSelectedQuestionId] = useState<QaQuestionId | null>(null);
  const [questionDetail, setQuestionDetail] = useState<QaQuestionDetail | null>(null);
  const [detailProblem, setDetailProblem] = useState<Problem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedKind, setSelectedKind] = useState<QaKind | ''>('');
  const [period, setPeriod] = useState<Period>('30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [scope, setScope] = useState<QaScopeLevel>('tenant');
  const [repositoryId, setRepositoryId] = useState('');
  const [pullRequestId, setPullRequestId] = useState('');
  const [commitSha, setCommitSha] = useState('');
  const [breakdown, setBreakdown] = useState<QaDimension | ''>('');
  const [urlReady, setUrlReady] = useState(false);
  const [answer, setAnswer] = useState<QaEnvelope | null>(null);
  const [answerProblem, setAnswerProblem] = useState<Problem | null>(null);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [extraDrilldown, setExtraDrilldown] = useState<QaDrilldownItem[]>([]);
  const [drilldownCursor, setDrilldownCursor] = useState<string | null>(null);
  const [drilldownAvailable, setDrilldownAvailable] = useState(true);
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownProblem, setDrilldownProblem] = useState<Problem | null>(null);
  const [attestationReference, setAttestationReference] = useState<string | null>(null);
  const answerGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    setListLoading(true);
    void getQaQuestions().then(result => {
      if (!active) return;
      setQuestionList({ items: result.items, version: result.registry_version });
      setQuestionListProblem(null);
    }).catch(cause => {
      if (active) setQuestionListProblem(describeProblem(cause, 'Question list is unavailable.'));
    }).finally(() => {
      if (active) setListLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const question = parameters.get('qaQuestion');
    if (isQuestionId(question)) setSelectedQuestionId(question);
    const kind = parameters.get('qaKind');
    if (kind === 'live' || kind === 'verifiable' || kind === 'signed') setSelectedKind(kind);
    const selectedPeriod = parameters.get('qaPeriod');
    if (selectedPeriod && PERIODS.includes(selectedPeriod as Period)) setPeriod(selectedPeriod as Period);
    setCustomFrom(localInput(parameters.get('qaFrom')));
    setCustomTo(localInput(parameters.get('qaTo')));
    const selectedScope = parameters.get('qaScope');
    if (selectedScope === 'tenant' || selectedScope === 'repository' || selectedScope === 'pull_request' || selectedScope === 'commit') {
      setScope(selectedScope);
    }
    setRepositoryId(parameters.get('qaRepository') ?? '');
    setPullRequestId(parameters.get('qaPullRequest') ?? '');
    setCommitSha(parameters.get('qaCommit') ?? '');
    const selectedBreakdown = parameters.get('qaBreakdown');
    if (isDimension(selectedBreakdown)) setBreakdown(selectedBreakdown);
    setUrlReady(true);
  }, []);

  useEffect(() => {
    if (!urlReady || !questionList) return;
    if (selectedQuestionId && questionList.items.some(question => question.id === selectedQuestionId)) return;
    setSelectedQuestionId(questionList.items[0]?.id ?? null);
  }, [questionList, selectedQuestionId, urlReady]);

  useEffect(() => {
    if (!urlReady) return;
    const parameters = new URLSearchParams(window.location.search);
    const entries: Array<[string, string]> = [
      ['qaQuestion', selectedQuestionId ?? ''],
      ['qaKind', selectedKind],
      ['qaPeriod', period],
      ['qaScope', scope],
      ['qaRepository', repositoryId],
      ['qaPullRequest', pullRequestId],
      ['qaCommit', commitSha],
      ['qaBreakdown', breakdown],
      ['qaFrom', period === 'custom' ? localInputIso(customFrom) : ''],
      ['qaTo', period === 'custom' ? localInputIso(customTo) : ''],
    ];
    for (const [key, value] of entries) {
      if (value) parameters.set(key, value);
      else parameters.delete(key);
    }
    const query = parameters.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', nextUrl);
  }, [
    urlReady, selectedQuestionId, selectedKind, period, customFrom, customTo,
    scope, repositoryId, pullRequestId, commitSha, breakdown,
  ]);

  useEffect(() => {
    if (!selectedQuestionId) {
      setQuestionDetail(null);
      setDetailProblem(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setQuestionDetail(null);
    setDetailProblem(null);
    void getQaQuestion(selectedQuestionId).then(result => {
      if (active) setQuestionDetail(result);
    }).catch(cause => {
      if (active) setDetailProblem(describeProblem(cause, 'Question details are unavailable.'));
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => { active = false; };
  }, [selectedQuestionId]);

  const selectedQuestion = questionList?.items.find(question => question.id === selectedQuestionId) ?? null;
  const filteredQuestions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (questionList?.items ?? [])
      .filter(question => !needle || `${question.id} ${question.title} ${question.family}`.toLowerCase().includes(needle))
      .sort((left, right) => {
        if (left.family !== right.family) return left.family === 'code' ? -1 : 1;
        return left.rank - right.rank;
      });
  }, [questionList, search]);

  useEffect(() => {
    if (!questionDetail || questionDetail.question.id !== selectedQuestionId) return;
    const question = questionDetail.question;
    if (!question.scopes.includes(scope)) setScope(question.scopes[0] ?? 'tenant');
    if (breakdown && !question.dimensions.includes(breakdown)) setBreakdown('');
    const usableKinds = questionDetail.answers.filter(item => item.built && !(isAuditor && item.kind === 'live'));
    if (!usableKinds.some(item => item.kind === selectedKind)) {
      setSelectedKind(usableKinds[0]?.kind ?? '');
    }
  }, [questionDetail, selectedQuestionId, isAuditor, scope, breakdown, selectedKind]);

  const selectedAnswerKind = questionDetail?.question.id === selectedQuestionId
    ? questionDetail.answers.find(item => item.kind === selectedKind)
    : undefined;
  const request = useMemo(() => {
    if (!selectedQuestionId || !selectedAnswerKind?.built || !selectedKind || (isAuditor && selectedKind === 'live')) return null;
    if (selectedQuestion && !selectedQuestion.scopes.includes(scope)) return null;
    if (selectedQuestion && breakdown && !selectedQuestion.dimensions.includes(breakdown)) return null;
    return buildQuery({
      kind: selectedKind,
      period,
      customFrom,
      customTo,
      scope,
      repositoryId,
      pullRequestId,
      commitSha,
      breakdown,
    });
  }, [
    selectedQuestionId, selectedQuestion, selectedAnswerKind?.built, selectedKind, isAuditor,
    period, customFrom, customTo, scope, repositoryId, pullRequestId, commitSha, breakdown,
  ]);

  useEffect(() => {
    answerGeneration.current += 1;
    if (!selectedQuestionId || !selectedAnswerKind?.built || !selectedKind || !request) {
      setAnswer(null);
      setAnswerProblem(null);
      setAnswerLoading(false);
      setExtraDrilldown([]);
      setDrilldownCursor(null);
      setDrilldownAvailable(true);
      setDrilldownLoading(false);
      setDrilldownProblem(null);
      return;
    }
    const generation = answerGeneration.current;
    let active = true;
    setAnswerLoading(true);
    setAnswer(null);
    setAnswerProblem(null);
    setExtraDrilldown([]);
    setDrilldownCursor(null);
    setDrilldownAvailable(true);
    setDrilldownProblem(null);
    void getQaAnswer(selectedQuestionId, request).then(result => {
      if (active) setAnswer(result);
    }).catch(cause => {
      if (active) setAnswerProblem(describeProblem(cause, 'This answer is unavailable.'));
    }).finally(() => {
      if (active) setAnswerLoading(false);
    });
    return () => {
      active = false;
      answerGeneration.current += 1;
    };
  }, [selectedQuestionId, selectedAnswerKind?.built, selectedKind, request]);

  function selectQuestion(id: QaQuestionId): void {
    setSelectedQuestionId(id);
    setAnswer(null);
    setAnswerProblem(null);
  }

  async function loadMoreDrilldown(): Promise<void> {
    if (!selectedQuestionId || !selectedKind || !request || !answer?.drilldown.length || drilldownLoading) return;
    const generation = answerGeneration.current;
    setDrilldownLoading(true);
    setDrilldownProblem(null);
    try {
      const lastEnvelopeItem = answer.drilldown[answer.drilldown.length - 1];
      const initialCursor = window.btoa(lastEnvelopeItem.id).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const page: QaDrilldownPage = await getQaAnswer(selectedQuestionId, {
        ...request,
        limit: 50,
        cursor: drilldownCursor ?? initialCursor,
      }, true);
      if (answerGeneration.current !== generation) return;
      setExtraDrilldown(current => [...current, ...page.items]);
      setDrilldownCursor(page.next_cursor);
      if (!page.next_cursor) setDrilldownAvailable(false);
    } catch (cause) {
      if (answerGeneration.current !== generation) return;
      const problem = describeProblem(cause, 'Could not load more items.');
      if (problem.code === 'QA_DRILLDOWN_NOT_BUILT') {
        setDrilldownAvailable(false);
      } else {
        setDrilldownProblem(problem);
      }
    } finally {
      if (answerGeneration.current === generation) setDrilldownLoading(false);
    }
  }

  const codeQuestions = filteredQuestions.filter(question => question.family === 'code');
  const securityQuestions = filteredQuestions.filter(question => question.family === 'security');
  const builtKinds = questionDetail?.question.id === selectedQuestionId
    ? questionDetail.answers.filter(item => item.built && !(isAuditor && item.kind === 'live'))
    : [];
  const disabledLiveAvailable = isAuditor
    && questionDetail?.question.id === selectedQuestionId
    && questionDetail.answers.some(item => item.kind === 'live');
  const unbuiltKinds = questionDetail?.question.id === selectedQuestionId
    ? questionDetail.answers.filter(item => !item.built)
    : [];
  const openGapIds = questionDetail?.question.id === selectedQuestionId
    ? [...new Set(questionDetail.answers.flatMap(item => item.open_gaps))]
    : [];
  const combinedDrilldown = [...(answer?.drilldown ?? []), ...extraDrilldown];
  const questionMatches = (question: QaQuestion) => question.id === selectedQuestionId;
  const selectedPullRequest = pullRequests.find(row => row.id === pullRequestId);
  const validCommitSha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commitSha);

  if (attestationReference) {
    return <div className="space-y-4">
      <button type="button" onClick={() => setAttestationReference(null)}
        className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
        Back to Questions
      </button>
      <p className="break-all rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-400">
        Answer evidence reference: <span className="font-mono text-slate-300">{attestationReference}</span>
      </p>
      <AttestaWorkspace repositories={repositories} />
    </div>;
  }

  return <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(18rem,0.36fr)_minmax(0,0.64fr)]">
    <aside className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/50 p-4" aria-label="Questions list">
      <div className="mb-4">
        <label htmlFor="qa-question-search" className="mb-2 block text-sm font-medium text-slate-200">Search questions</label>
        <input id="qa-question-search" value={search} onChange={event => setSearch(event.target.value)}
          placeholder="Search by question or ID"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400" />
      </div>
      {questionListProblem && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
        {questionListProblem.message}
        {questionListProblem.requestId && <div className="mt-2 text-xs text-rose-200/70">Request ID: {questionListProblem.requestId}</div>}
      </div>}
      {listLoading && <p className="py-4 text-sm text-slate-400">Loading question registry…</p>}
      {questionList && <>
        <QuestionGroup title="Code questions" questions={codeQuestions} selectedId={selectedQuestionId} onSelect={selectQuestion} />
        <QuestionGroup title="Security questions" questions={securityQuestions} selectedId={selectedQuestionId} onSelect={selectQuestion} />
        {!filteredQuestions.length && <p className="py-5 text-sm text-slate-500">No questions match this search.</p>}
        <p className="mt-4 border-t border-slate-800 pt-3 text-xs text-slate-500">Registry version {questionList.version}</p>
      </>}
    </aside>

    <section className="min-w-0 space-y-4" aria-label="Question answer">
      {!selectedQuestion && <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 text-sm text-slate-400">
        {listLoading ? 'Choose a question when the registry has loaded.' : 'No questions are available.'}
      </div>}
      {selectedQuestion && <>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="font-mono text-xs text-violet-300">{selectedQuestion.id} · {selectedQuestion.family === 'code' ? 'Code question' : 'Security question'}</div>
              <h2 className="mt-2 text-lg font-semibold leading-7 text-white">{selectedQuestion.title}</h2>
            </div>
            <Badge tone="slate">Rank {selectedQuestion.rank}</Badge>
          </div>

          {detailLoading && <p className="mt-4 text-sm text-slate-400">Loading answer options…</p>}
          {detailProblem && <div role="alert" className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            {detailProblem.message}
            {detailProblem.requestId && <div className="mt-2 text-xs text-rose-200/70">Request ID: {detailProblem.requestId}</div>}
          </div>}

          {questionDetail?.question.id === selectedQuestionId && <>
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Answer type">
                <select value={selectedKind} onChange={event => setSelectedKind(event.target.value as QaKind | '')}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
                  {!builtKinds.length && <option value="">No built answer</option>}
                  {builtKinds.map(item => <option key={item.kind} value={item.kind}>{item.kind}</option>)}
                  {disabledLiveAvailable && <option value="live" disabled>live — Live answers are for administrators</option>}
                </select>
                {isAuditor && disabledLiveAvailable && <span className="mt-1 block text-xs text-amber-300">Live answers are for administrators</span>}
              </Field>
              <Field label="Period">
                <select value={period} onChange={event => setPeriod(event.target.value as Period)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
                  <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom range</option>
                </select>
              </Field>

              {period === 'custom' && <div className="grid grid-cols-1 gap-3 sm:col-span-2 sm:grid-cols-2">
                <Field label="From">
                  <input type="datetime-local" step="0.001" value={customFrom} onChange={event => setCustomFrom(event.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400" />
                </Field>
                <Field label="To">
                  <input type="datetime-local" step="0.001" value={customTo} onChange={event => setCustomTo(event.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400" />
                </Field>
              </div>}

              <Field label="Scope">
                <select value={scope} onChange={event => setScope(event.target.value as QaScopeLevel)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
                  {selectedQuestion.scopes.map(level => <option key={level} value={level}>{scopeLabel(level)}</option>)}
                </select>
              </Field>

              {scope === 'repository' && <Field label="Repository">
                <select value={repositoryId} onChange={event => setRepositoryId(event.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
                  <option value="">Select a repository</option>
                  {repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.name}</option>)}
                </select>
              </Field>}
              {scope === 'pull_request' && <Field label="Pull request">
                <select value={pullRequestId} onChange={event => setPullRequestId(event.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
                  <option value="">Select a pull request</option>
                  {pullRequests.map(row => <option key={row.id} value={row.id}>{repositories.find(repository => repository.id === row.repositoryId)?.name ?? 'Repository'} · {row.title}</option>)}
                </select>
              </Field>}
              {scope === 'commit' && <>
                <Field label="Repository">
                  <select value={repositoryId} onChange={event => setRepositoryId(event.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
                    <option value="">Select a repository</option>
                    {repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.name}</option>)}
                  </select>
                </Field>
                <Field label="Commit SHA">
                  <input value={commitSha} onChange={event => setCommitSha(event.target.value.toLowerCase())}
                    placeholder="40- or 64-character commit SHA"
                    aria-invalid={Boolean(commitSha) && !validCommitSha}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400" />
                  {Boolean(commitSha) && !validCommitSha && <span className="mt-1 block text-xs text-amber-300">Enter a lowercase 40- or 64-character SHA.</span>}
                </Field>
              </>}

              <Field label="Breakdown">
                <select value={breakdown} onChange={event => setBreakdown(event.target.value as QaDimension | '')}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
                  <option value="">None</option>
                  {selectedQuestion.dimensions.map(dimension => <option key={dimension} value={dimension}>{dimension.replaceAll('_', ' ')}</option>)}
                </select>
                <span className="mt-1 block text-xs text-slate-500">Breakdown is off by default.</span>
                {selectedQuestion.dimensions.some(dimension => String(dimension) === 'contributor' || String(dimension) === 'user')
                  && <span className="mt-1 block text-xs text-amber-300">Shows individuals; use for coaching, not ranking.</span>}
              </Field>
            </div>
          </>}
        </div>

        {unbuiltKinds.length > 0 && <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <h3 className="font-medium text-white">Answers not built yet</h3>
          <div className="mt-3 space-y-3">
            {unbuiltKinds.map(item => <div key={item.kind} className="rounded-lg border border-slate-800 p-3">
              <div className="flex items-center gap-2"><Badge tone="amber">{item.kind}</Badge><span className="text-sm text-slate-200">Not built yet</span></div>
              {item.open_gaps.length > 0
                ? <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-400">Open gaps: {item.open_gaps.map(gap => <a key={gap} href={`#qa-gap-${gap}`} className="text-violet-300 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">{gap}</a>)}</div>
                : <p className="mt-2 text-xs text-slate-500">No open gaps are listed for this answer.</p>}
            </div>)}
          </div>
        </div>}
        {openGapIds.length > 0 && <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4" aria-label="Open gap identifiers">
          <h3 className="text-sm font-medium text-white">Open gap references</h3>
          <p className="mt-1 text-xs text-slate-500">The question registry response provides gap IDs but not their titles.</p>
          <ul className="mt-2 flex flex-wrap gap-2 text-xs text-violet-300">
            {openGapIds.map(gap => <li key={gap} id={`qa-gap-${gap}`} className="rounded border border-slate-700 px-2 py-1">Gap {gap}</li>)}
          </ul>
        </div>}

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-white">{selectedKind ? `${selectedKind[0].toUpperCase()}${selectedKind.slice(1)} answer` : 'Answer'}</h3>
            {answer && <Badge tone={availabilityTone(answer.availability)}>{availabilityLabel(answer.availability)}</Badge>}
          </div>

          {answerLoading && <p className="mt-4 text-sm text-slate-400">Loading answer…</p>}
          {answerProblem && <div role="alert" className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            {answerProblem.message}
            {answerProblem.requestId && <div className="mt-2 text-xs text-rose-200/70">Request ID: {answerProblem.requestId}</div>}
          </div>}

          {questionDetail?.question.id === selectedQuestionId && isAuditor && selectedKind === 'live'
            && <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-200">Live answers are for administrators.</p>}
          {questionDetail?.question.id === selectedQuestionId && isAuditor && !selectedKind && disabledLiveAvailable
            && <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-200">Live answers are for administrators.</p>}
          {questionDetail?.question.id === selectedQuestionId && selectedAnswerKind && !selectedAnswerKind.built
            && <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-200">Not built yet. Its open gaps are listed above; no answer request was sent.</p>}
          {questionDetail?.question.id === selectedQuestionId && selectedAnswerKind?.built && !request && !isAuditor
            && <p className="mt-4 text-sm text-amber-300">Complete the selected period and scope filters to request this answer.</p>}

          {answer && <>
            <p className="mt-3 text-sm text-slate-400">As of {new Date(answer.as_of).toLocaleString()} · Scope: {answer.scope.commit_sha ? `commit ${answer.scope.commit_sha.slice(0, 9)}` : answer.scope.pull_request_id ? `pull request ${selectedPullRequest?.title ?? answer.scope.pull_request_id}` : answer.scope.repository_id ? repositories.find(repository => repository.id === answer.scope.repository_id)?.name ?? 'Repository' : 'Entire tenant'}</p>
            {answer.availability === 'unavailable'
              && <p className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 text-sm text-rose-200">Not available. No figure is shown as zero.</p>}
            {answer.reasons.length > 0 && <div className="mt-3 flex flex-wrap gap-2" aria-label="Answer reasons">{answer.reasons.map((reason, index) => <ReasonPill key={`${reason.code}-${reason.gap ?? ''}-${index}`} reason={reason} />)}</div>}
            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {answer.figures.map(figure => <FigureCard key={figure.key} figure={figure}
                previous={answer.previous?.figures.find(item => item.key === figure.key)}
                repositories={repositories} onOpenAttestation={setAttestationReference} />)}
            </div>
            {answer.previous && <p className="mt-3 text-xs text-slate-500">
              Previous period: {new Date(answer.previous.from).toLocaleDateString()} – {new Date(answer.previous.to).toLocaleDateString()}
            </p>}
            {answer.wording.length > 0 && <div className="mt-4 border-t border-slate-800 pt-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Caveats</h4>
              <ul className="mt-2 space-y-1 text-sm text-slate-300">{answer.wording.map(code => <li key={code}>{QA_WORDING_MESSAGES[code] ?? code}</li>)}</ul>
            </div>}
            {(answer.signed_evidence || answer.signed) && <div className="mt-4 border-t border-slate-800 pt-3">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Badge tone="violet">{answer.signed ? 'Signed report' : 'Signed evidence available'}</Badge>
                {answer.signed?.statement_digest && <span className="font-mono text-xs text-slate-400">{answer.signed.statement_digest}</span>}
                <EvidenceLink reference={signedEvidenceReference(answer)} onOpen={setAttestationReference} />
              </div>
            </div>}
            {answer.drilldown.length > 0 && <div className="mt-4 border-t border-slate-800 pt-3">
              <h4 className="text-sm font-medium text-white">Drill-down</h4>
              <ul className="mt-2 space-y-2">
                {combinedDrilldown.map((item, index) => <li key={`${item.scope}-${item.id}-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm">
                  <span className="text-slate-200">{item.label}</span><span className="text-xs text-slate-500">{item.scope}</span>
                </li>)}
              </ul>
              {drilldownAvailable && <button type="button" onClick={() => void loadMoreDrilldown()} disabled={drilldownLoading}
                className="mt-3 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 disabled:opacity-50">
                {drilldownLoading ? 'Loading…' : drilldownCursor ? 'Load more' : 'Load more'}
              </button>}
              {drilldownProblem && <div role="alert" className="mt-2 text-sm text-rose-200">
                {drilldownProblem.message}
                {drilldownProblem.requestId && <div className="mt-1 text-xs text-rose-200/70">Request ID: {drilldownProblem.requestId}</div>}
              </div>}
            </div>}
          </>}
        </div>
      </>}
    </section>
  </div>;
}
