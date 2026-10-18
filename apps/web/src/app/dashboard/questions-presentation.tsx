'use client';

import type {
  QaAvailability,
  QaDimension,
  QaFigure,
  QaQuestion,
  QaQuestionId,
  QaReason,
  QaValue,
  Repository,
} from '@/lib/api';

export const QA_REASON_MESSAGES: Record<string, string> = {
  not_captured_yet: 'This information is not being captured yet.',
  not_monitored: 'This platform or activity is not monitored.',
  vendor_does_not_report: 'The provider does not report this information.',
  never_written: 'This value is never written by the current system.',
  partial_linkage: 'Some related records cannot be linked with confidence.',
  answer_not_built: 'This answer has not been built yet.',
  phase_2: 'This question is planned for a later phase.',
};

export const QA_WORDING_MESSAGES: Record<string, string> = {
  monitor_only_observed: 'Observed in monitor mode; nothing was blocked.',
  unknown_model_explicit: 'Some model identities are unknown.',
  merged_not_deployed_proxy: 'Merged changes are shown as a proxy; production deployment is not confirmed.',
  churned_unavailable: 'Churned code is unavailable because it is not recorded.',
  session_link_partial: 'Links between sessions and findings are partial.',
  requested_not_confirmed: 'Requested actions are not confirmed outcomes.',
  metadata_only: 'This answer contains metadata only.',
};

export const QA_PROBLEM_MESSAGES: Record<string, string> = {
  QA_UNAUTHENTICATED: 'Sign in again to view Questions.',
  QA_FORBIDDEN: 'Your account does not have access to these answers.',
  QA_QUESTION_NOT_FOUND: 'This question is no longer available.',
  QA_KIND_NOT_OFFERED: 'This answer type is not offered for this question.',
  QA_KIND_NOT_ALLOWED: 'This answer type is not available to your role.',
  QA_SCOPE_INVALID: 'Review the answer filters; one or more values are invalid.',
  QA_SCOPE_NOT_FOUND: 'The selected repository, pull request, or commit was not found.',
  QA_DRILLDOWN_NOT_BUILT: 'Drill-down is not available for this answer.',
  QA_ANSWER_INVALID: 'The server could not verify the answer envelope.',
  QA_UNAVAILABLE: 'The answer service is temporarily unavailable.',
};

export function Badge({ children, tone = 'slate' }: {
  children: React.ReactNode;
  tone?: 'slate' | 'green' | 'amber' | 'rose' | 'violet';
}) {
  const styles = {
    slate: 'bg-slate-800 text-slate-300',
    green: 'bg-emerald-500/10 text-emerald-300',
    amber: 'bg-amber-500/10 text-amber-300',
    rose: 'bg-rose-500/10 text-rose-200',
    violet: 'bg-violet-500/10 text-violet-300',
  };
  return <span className={`rounded-full px-2.5 py-1 text-xs ${styles[tone]}`}>{children}</span>;
}

export function availabilityTone(value: QaAvailability): 'green' | 'amber' | 'rose' {
  if (value === 'recorded') return 'green';
  if (value === 'partial') return 'amber';
  return 'rose';
}

export function availabilityLabel(value: QaAvailability): string {
  if (value === 'unavailable') return 'Not available';
  return value === 'partial' ? 'Partial' : 'Recorded';
}

function number(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

function valueNumber(value: QaValue): number {
  if (value.type === 'count') return value.count;
  if (value.type === 'duration_ms') return value.ms;
  return value.numerator / value.denominator;
}

function formatValue(value: QaValue): string {
  if (value.type === 'count') return number(value.count);
  if (value.type === 'duration_ms') return `${number(value.ms)} ms`;
  const percent = (value.numerator / value.denominator) * 100;
  return `${number(value.numerator)} / ${number(value.denominator)} (${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(percent)}%)`;
}

function formatChange(current: QaValue, previous: QaValue): string {
  if (current.type !== previous.type) return 'Change unavailable (value types differ)';
  if (current.type === 'ratio' && previous.type === 'ratio') {
    const points = ((current.numerator / current.denominator) - (previous.numerator / previous.denominator)) * 100;
    const prefix = points > 0 ? '+' : '';
    return `${prefix}${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(points)} percentage points`;
  }
  if (current.type === 'count' && previous.type === 'count') {
    const difference = current.count - previous.count;
    return `${difference > 0 ? '+' : ''}${number(difference)}`;
  }
  if (current.type === 'duration_ms' && previous.type === 'duration_ms') {
    const difference = current.ms - previous.ms;
    return `${difference > 0 ? '+' : ''}${number(difference)} ms`;
  }
  return 'Change unavailable';
}

function reasonText(reason: QaReason): string {
  return QA_REASON_MESSAGES[reason.code] ?? reason.code;
}

export function ReasonList({ reasons }: { reasons: QaReason[] }) {
  if (!reasons.length) return null;
  return <ul className="mt-2 space-y-1 text-xs text-slate-400">
    {reasons.map((reason, index) => <li key={`${reason.code}-${reason.gap ?? ''}-${index}`}>
      {reasonText(reason)}{reason.gap && <> <a className="text-violet-300 underline decoration-violet-500/40 underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400" href={`#qa-gap-${reason.gap}`}>{reason.gap}</a></>}
    </li>)}
  </ul>;
}

export function ReasonPill({ reason }: { reason: QaReason }) {
  return <span className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300">
    {reasonText(reason)}{reason.gap && <> · <a className="text-violet-300 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400" href={`#qa-gap-${reason.gap}`}>{reason.gap}</a></>}
  </span>;
}

export function EvidenceLink({ reference, onOpen }: {
  reference: string;
  onOpen: (reference: string) => void;
}) {
  return <button type="button" onClick={() => onOpen(reference)} className="text-xs text-violet-300 underline decoration-violet-500/40 underline-offset-2 hover:text-violet-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
    Open Attestation
  </button>;
}

function formatBreakdownKey(key: string, dimension: QaDimension, repositories: Repository[]): string {
  if (key === 'unknown') return 'Unknown';
  if (dimension === 'repository') return repositories.find(repository => repository.id === key)?.name ?? 'Unknown';
  return key.replaceAll('_', ' ');
}

function Breakdown({ figure, repositories }: { figure: QaFigure; repositories: Repository[] }) {
  const items = [...(figure.breakdown ?? [])].sort((left, right) => valueNumber(right.value) - valueNumber(left.value));
  if (!items.length) return null;
  const maximum = Math.max(1, ...items.map(item => valueNumber(item.value)));
  return <div className="mt-4 space-y-3" aria-label={`${figure.key} breakdown`}>
    {items.map((item, index) => {
      const width = Math.max(0, (valueNumber(item.value) / maximum) * 100);
      return <div key={`${item.dimension}-${item.key}-${index}`}>
        <div className="mb-1 flex items-center justify-between gap-3 text-xs">
          <span className="truncate text-slate-300">{formatBreakdownKey(item.key, item.dimension, repositories)}</span>
          <span className="shrink-0 text-slate-400">{formatValue(item.value)}</span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-slate-800">
          <div className="h-full rounded bg-violet-500" style={{ width: `${width}%` }} />
        </div>
      </div>;
    })}
  </div>;
}

export function FigureCard({ figure, previous, repositories, onOpenAttestation }: {
  figure: QaFigure;
  previous?: QaFigure;
  repositories: Repository[];
  onOpenAttestation: (reference: string) => void;
}) {
  return <article className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium text-white">{figure.key.replaceAll('_', ' ')}</h4>
      <Badge tone={availabilityTone(figure.availability)}>{availabilityLabel(figure.availability)}</Badge>
    </div>
    {figure.availability === 'unavailable' ? <p className="mt-3 text-sm text-rose-200">Not available</p>
      : figure.value && <div className="mt-3 text-2xl font-semibold text-white">{formatValue(figure.value)}</div>}
    <ReasonList reasons={figure.reasons} />
    {previous && <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
      <div className="flex flex-wrap items-center gap-2">
        <span>Previous period:</span>
        <Badge tone={availabilityTone(previous.availability)}>{availabilityLabel(previous.availability)}</Badge>
        {previous.availability === 'unavailable' || !previous.value
          ? <span>Not available</span>
          : <span className="text-slate-200">{formatValue(previous.value)}</span>}
      </div>
      {previous.availability !== 'recorded' && <ReasonList reasons={previous.reasons} />}
      {previous.value && previous.availability !== 'unavailable' && <div className="mt-1">
        {figure.value && figure.availability !== 'unavailable'
          ? <>Change: {formatChange(figure.value, previous.value)}</>
          : 'Change unavailable'}
      </div>}
    </div>}
    {figure.availability !== 'unavailable' && <Breakdown figure={figure} repositories={repositories} />}
    {figure.evidence && <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-3 text-xs text-slate-500">
      <span>{number(figure.evidence.count)} signed evidence records</span>
      <span className="font-mono">Root {figure.evidence.statements_root.slice(0, 20)}…</span>
      <EvidenceLink
        reference={`Evidence root: ${figure.evidence.statements_root}; ${number(figure.evidence.count)} records`}
        onOpen={onOpenAttestation}
      />
    </div>}
  </article>;
}

export function QuestionGroup({ title, questions, selectedId, onSelect }: {
  title: string;
  questions: QaQuestion[];
  selectedId: QaQuestionId | null;
  onSelect: (id: QaQuestionId) => void;
}) {
  return <section className="mt-4 first:mt-0">
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</h3>
    <div className="space-y-2">
      {questions.map(question => <QuestionListButton key={question.id} question={question}
        selected={question.id === selectedId} onSelect={() => onSelect(question.id)} />)}
    </div>
  </section>;
}

function QuestionListButton({ question, selected, onSelect }: {
  question: QaQuestion;
  selected: boolean;
  onSelect: () => void;
}) {
  return <button type="button" onClick={onSelect} aria-pressed={selected}
    className={`w-full rounded-lg border p-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 ${selected ? 'border-violet-500/60 bg-violet-500/10' : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'}`}>
    <div className="flex items-start justify-between gap-2">
      <span className="font-mono text-xs text-violet-300">{question.id}</span>
      <span className="flex flex-wrap justify-end gap-1">
        {question.kinds.map(item => <span key={item.kind} className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">{item.kind}</span>)}
      </span>
    </div>
    <span className="mt-2 block text-sm leading-5 text-slate-200">{question.title}</span>
  </button>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm text-slate-300">
    <span className="mb-1.5 block font-medium">{label}</span>
    {children}
  </label>;
}
