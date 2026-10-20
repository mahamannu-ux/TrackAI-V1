/**
 * The question registry as code (Task19a, T19.2): one entry per row of
 * docs/plan/CUSTOMER_AUDITOR_QA.md, with the kinds of answer the delivery matrix
 * (docs/plan/TASK19.md §3) offers and who builds each.
 *
 * Shape from Task16b's audit catalog (core/audit/catalog.ts, generate-catalog.ts;
 * catalog CF-1's "generated and test-checked reference"): `questions.md` is generated
 * from this file by `npm run qa:registry -w apps/api`, and a unit test fails when
 * it is stale.
 *
 * Rules (docs/contracts/qa/README.md):
 * - bump QA_REGISTRY_VERSION whenever an entry is added or changed;
 * - ids are never reused;
 * - no scope or dimension ever names a person (a unit test refuses one).
 */
import type {
  QaBuilder, QaDimension, QaGap, QaGapId, QaKind, QaQuestion, QaQuestionKind, QaScopeLevel, QaWordingCode,
} from './types';

export const QA_REGISTRY_VERSION = 3;

const k = (kind: QaKind, builder: QaBuilder | null): QaQuestionKind => ({ kind, builder });

const TENANT_REPO: readonly QaScopeLevel[] = ['tenant', 'repository'];
const TENANT_REPO_PR: readonly QaScopeLevel[] = ['tenant', 'repository', 'pull_request'];

interface Entry {
  id: QaQuestion['id'];
  rank: number;
  title: string;
  auditor: QaQuestion['auditor'];
  kinds: QaQuestionKind[];
  gaps?: QaGapId[];
  scopes: readonly QaScopeLevel[];
  dimensions?: QaDimension[];
  compare_previous?: boolean;
  wording?: QaWordingCode[];
  phase?: 1 | 2;
}

const code = (e: Entry): QaQuestion => ({
  id: e.id, family: 'code', rank: e.rank, phase: e.phase ?? 1, title: e.title, auditor: e.auditor,
  kinds: e.kinds, gaps: e.gaps ?? [], scopes: e.scopes, dimensions: e.dimensions ?? [],
  compare_previous: e.compare_previous ?? false, wording: e.wording ?? [],
});

/** Every security answer is worded "observed": monitor-only evidence is never prevention (rule 7). */
const security = (e: Entry): QaQuestion => ({
  ...code(e), family: 'security', wording: ['monitor_only_observed', ...(e.wording ?? [])],
});

export const QA_QUESTIONS: readonly QaQuestion[] = [
  // --- Code questions (CUSTOMER_AUDITOR_QA.md, ranked) ---
  code({ id: 'Q3', rank: 1, auditor: 'yes',
    title: 'Over a period, what share of merged changes in a repository were AI-assisted, by tool and model?',
    kinds: [k('live', 'T19.3'), k('verifiable', 'A16.13a'), k('signed', 'Task15i4')],
    scopes: TENANT_REPO, dimensions: ['model', 'tool', 'repository'], wording: ['unknown_model_explicit'] }),
  code({ id: 'Q1', rank: 2, auditor: 'yes',
    title: 'What share of a repository\'s code was AI-generated as of a date (today: the share of lines changed in a period)?',
    kinds: [k('live', 'T19.3'), k('verifiable', 'A16.13a'), k('signed', 'Task15i4')],
    gaps: ['G1'], scopes: TENANT_REPO, dimensions: ['repository'] }),
  code({ id: 'Q4', rank: 3, auditor: 'yes',
    title: 'Which AI tools and models touched production code, and was each approved at the time?',
    kinds: [k('live', 'T19.3'), k('verifiable', 'A16.13a')],
    gaps: ['G2'], scopes: ['tenant', 'repository', 'commit'], dimensions: ['model', 'tool', 'repository'],
    wording: ['unknown_model_explicit'] }),
  code({ id: 'Q11', rank: 4, auditor: 'yes',
    title: 'Did the AI sessions behind this code raise security findings, and of what kind?',
    kinds: [k('live', 'T19.3'), k('verifiable', 'A16.13a')],
    gaps: ['G10'], scopes: ['tenant', 'repository', 'pull_request', 'commit'],
    dimensions: ['rule_category', 'severity', 'repository'],
    wording: ['monitor_only_observed', 'session_link_partial'] }),
  code({ id: 'Q7', rank: 5, auditor: 'yes',
    title: 'Can you prove these records were not changed after the fact?',
    kinds: [k('verifiable', 'A16.13a')], scopes: TENANT_REPO }),
  code({ id: 'Q16', rank: 6, auditor: 'yes',
    title: 'Export everything for a repository and period, verifiable offline without TrackAI.',
    kinds: [k('verifiable', 'A16.13a')], scopes: TENANT_REPO }),
  code({ id: 'Q5', rank: 7, auditor: 'yes',
    title: 'Was AI-generated code reviewed by someone other than its author before merge?',
    kinds: [k('live', 'T19.3'), k('verifiable', 'A16.13a')],
    gaps: ['G3'], scopes: TENANT_REPO_PR, dimensions: ['repository'] }),
  code({ id: 'Q13', rank: 8, auditor: 'yes',
    title: 'How complete is the evidence? Which commits have no AI attribution (no Git AI note, unenrolled machine, unknown lines)?',
    kinds: [k('live', 'T19.3'), k('verifiable', 'A16.13a'), k('signed', 'Task15i4')],
    scopes: ['tenant', 'repository', 'commit'], dimensions: ['repository'] }),
  code({ id: 'Q9', rank: 9, auditor: 'yes',
    title: 'Which AI-assisted changes reached production, when, and through which deployment?',
    kinds: [k('live', 'T19.3'), k('verifiable', 'A16.13a'), k('signed', 'Task15i4')],
    scopes: TENANT_REPO_PR, dimensions: ['repository'], wording: ['merged_not_deployed_proxy'] }),
  code({ id: 'Q14', rank: 10, auditor: 'yes',
    title: 'For one pull request, show the chain: prompt, session, commits, pull request, merge, deployment.',
    kinds: [k('live', 'T19.3'), k('verifiable', 'A16.13a')],
    scopes: ['pull_request'], wording: ['metadata_only'] }),
  code({ id: 'Q12', rank: 11, auditor: 'yes',
    title: 'What policy was in force for a repository when this change was made?',
    kinds: [k('live', 'T19.3'), k('verifiable', 'A16.13a')],
    gaps: ['G2'], scopes: ['repository', 'commit'] }),
  code({ id: 'Q2', rank: 12, auditor: 'yes',
    title: 'For one line of a file at a commit or date: was it written by AI, by which agent, model and session, and when?',
    kinds: [k('live', 'Task19d'), k('verifiable', null)],
    scopes: ['commit'], wording: ['metadata_only'] }),
  code({ id: 'Q6', rank: 13, auditor: 'yes',
    title: 'Who committed, and who merged, each AI-assisted change?',
    kinds: [k('live', 'T19.3'), k('verifiable', 'A16.13a')],
    gaps: ['G4'], scopes: ['repository', 'pull_request'], dimensions: ['repository'] }),
  code({ id: 'Q8', rank: 14, auditor: 'yes',
    title: 'When did TrackAI first see this commit, and was the evidence signed then, not rebuilt later?',
    kinds: [k('verifiable', 'A16.13a')], scopes: ['commit'] }),
  code({ id: 'Q15', rank: 15, auditor: 'yes',
    title: 'Did any AI-assisted code come from a machine or repository without a valid grant, and was it rejected?',
    kinds: [k('live', 'T19.3'), k('verifiable', 'A16.13a')],
    gaps: ['G5'], scopes: TENANT_REPO, dimensions: ['repository', 'machine'] }),
  code({ id: 'Q10', rank: 16, auditor: 'partly',
    title: 'How much AI code was reworked or deleted before merge, and by AI or by a human?',
    kinds: [k('live', 'T19.3')], scopes: TENANT_REPO_PR, dimensions: ['repository'],
    wording: ['churned_unavailable'] }),
  code({ id: 'Q19', rank: 17, auditor: 'no',
    title: 'What is the AI acceptance rate (generated, kept, committed)?',
    kinds: [k('live', 'T19.3')], scopes: TENANT_REPO_PR, dimensions: ['model', 'tool', 'repository'] }),
  code({ id: 'Q18', rank: 18, auditor: 'no',
    title: 'What did AI cost (tokens, money) per repository, pull request and model?',
    kinds: [k('live', 'T19.3')], scopes: TENANT_REPO_PR, dimensions: ['model', 'tool', 'repository'] }),
  code({ id: 'Q20', rank: 19, auditor: 'no',
    title: 'Which teams use AI most, and how is it changing?',
    kinds: [k('live', 'T19.3')], scopes: ['tenant'], dimensions: ['team', 'repository'], compare_previous: true }),
  code({ id: 'Q17', rank: 20, auditor: 'yes', phase: 2,
    title: 'Did AI bring third-party or open-source snippets in (licence risk)?',
    kinds: [k('live', null), k('verifiable', null)], scopes: TENANT_REPO, dimensions: ['repository'] }),

  // --- Security and policy questions (ranked) ---
  security({ id: 'S1', rank: 1, auditor: 'yes',
    title: 'Give me the register of every high or critical security finding in a period, across all repositories, and prove none was added, changed or removed afterwards.',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b'), k('signed', 'Task15p')],
    gaps: ['G6', 'G9'], scopes: TENANT_REPO, dimensions: ['rule', 'rule_category', 'severity', 'repository'] }),
  security({ id: 'S2', rank: 2, auditor: 'yes',
    title: 'Was monitoring actually on? Which machines and repositories were covered in a period, and where were the gaps?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b'), k('signed', 'Task15p')],
    gaps: ['G7'], scopes: TENANT_REPO, dimensions: ['machine', 'repository', 'operating_system'] }),
  security({ id: 'S3', rank: 3, auditor: 'yes',
    title: 'Did anyone switch off or tamper with the guardrails in a period?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b')],
    gaps: ['G8', 'G9'], scopes: ['tenant'], dimensions: ['machine', 'repository'] }),
  security({ id: 'S4', rank: 4, auditor: 'yes',
    title: 'Did any AI agent read secrets or credentials, and did data leave the machine afterwards?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b')],
    gaps: ['G9'], scopes: TENANT_REPO, dimensions: ['rule', 'machine', 'repository'] }),
  security({ id: 'S5', rank: 5, auditor: 'yes',
    title: 'For one finding, show the chain: machine, session, agent and model, repository, the commits and pull requests it produced, deployed?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b')],
    gaps: ['G6', 'G10'], scopes: TENANT_REPO, wording: ['session_link_partial', 'metadata_only'] }),
  security({ id: 'S6', rank: 6, auditor: 'yes',
    title: 'Did code from a session that raised a high or critical finding get merged or reach production?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b')],
    gaps: ['G10'], scopes: TENANT_REPO, dimensions: ['repository', 'severity'], wording: ['session_link_partial'] }),
  security({ id: 'S7', rank: 7, auditor: 'yes',
    title: 'Which repositories were most affected, by category and severity, and how does the period compare with the previous one?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b'), k('signed', 'Task15p')],
    gaps: ['G6'], scopes: ['tenant'], dimensions: ['repository', 'rule_category', 'severity'], compare_previous: true }),
  security({ id: 'S8', rank: 8, auditor: 'yes',
    title: 'Which agent or tool, and which model, produced the most findings?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b'), k('signed', 'Task15p')],
    gaps: ['G10'], scopes: TENANT_REPO, dimensions: ['agent_family', 'model'],
    wording: ['unknown_model_explicit', 'session_link_partial'] }),
  security({ id: 'S9', rank: 9, auditor: 'yes',
    title: 'Which platforms (macOS, Linux, Windows, WSL) produced the most findings, and in which categories?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b'), k('signed', 'Task15p')],
    scopes: ['tenant'], dimensions: ['operating_system', 'rule_category'] }),
  security({ id: 'S10', rank: 10, auditor: 'yes',
    title: 'Which rule-pack and detector versions were in force on each machine when findings occurred, and were machines up to date?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b'), k('signed', 'Task15p')],
    gaps: ['G6', 'G7'], scopes: TENANT_REPO, dimensions: ['machine'] }),
  security({ id: 'S11', rank: 11, auditor: 'yes',
    title: 'Which findings were confirmed outcomes, and which were only requested actions?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b'), k('signed', 'Task15p')],
    gaps: ['G6'], scopes: TENANT_REPO, dimensions: ['rule'], wording: ['requested_not_confirmed'] }),
  security({ id: 'S12', rank: 12, auditor: 'yes',
    title: 'Was anything blocked or prevented, and under which policy version?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b'), k('signed', 'Task15p')],
    gaps: ['G6'], scopes: TENANT_REPO, dimensions: ['repository'] }),
  security({ id: 'S13', rank: 13, auditor: 'yes',
    title: 'What organization policy was in force on each machine when a finding occurred, and did the machine hold a valid activation lease?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b')],
    gaps: ['G2', 'G11'], scopes: TENANT_REPO, dimensions: ['machine'] }),
  security({ id: 'S14', rank: 14, auditor: 'yes',
    title: 'Which policy exceptions or waivers were granted, for how long, and which findings fell under them?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b')],
    gaps: ['G12'], scopes: ['tenant'], dimensions: ['rule'] }),
  security({ id: 'S15', rank: 15, auditor: 'yes',
    title: 'Who looked at security findings and raw evidence in a period, and is that trail tamper-evident?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b')], scopes: ['tenant'] }),
  security({ id: 'S16', rank: 16, auditor: 'partly',
    title: 'How fast were findings triaged and remediated (time to acknowledge, time to close)?',
    kinds: [k('live', 'T19.4'), k('verifiable', 'A16.13b')],
    gaps: ['G13'], scopes: TENANT_REPO, dimensions: ['severity', 'rule'] }),
  security({ id: 'S17', rank: 17, auditor: 'partly',
    title: 'Which machines (or teams) generate repeated findings?',
    kinds: [k('live', 'T19.4')], scopes: TENANT_REPO, dimensions: ['machine', 'team'] }),
  security({ id: 'S18', rank: 18, auditor: 'no',
    title: 'Which rules fire most, and which are noisy (findings later marked benign)?',
    kinds: [k('live', 'T19.4')], gaps: ['G13'], scopes: ['tenant'], dimensions: ['rule'] }),
  security({ id: 'S19', rank: 19, auditor: 'yes',
    title: 'Which AI coding agents are installed on our machines, and which are not on the approved list?',
    kinds: [k('live', 'T19.4')], gaps: ['G14'], scopes: ['tenant'], dimensions: ['agent_family', 'operating_system', 'machine'] }),
  security({ id: 'S20', rank: 20, auditor: 'yes',
    title: 'Were we already exposed before TrackAI arrived? What did the day-one scan of existing agent sessions find?',
    kinds: [k('live', 'T19.4')], gaps: ['G14'], scopes: ['tenant'], dimensions: ['rule_category', 'severity'], wording: ['requested_not_confirmed'] }),
  security({ id: 'S26', rank: 21, auditor: 'yes',
    title: 'How often do agents ask permission, how often do developers approve or deny, and did sessions with findings get approvals?',
    kinds: [k('live', 'T19.4')], scopes: ['tenant'], dimensions: ['agent_family'], wording: ['requested_not_confirmed'] }),
  security({ id: 'S23', rank: 22, auditor: 'partly',
    title: 'Which external domains, URLs and addresses did agents reach in a period?',
    kinds: [k('live', 'T19.4')], scopes: ['tenant'], dimensions: ['agent_family'], wording: ['metadata_only'] }),
  security({ id: 'S21', rank: 23, auditor: 'yes',
    title: 'Which agents ran in reduced-approval or bypass modes, and how often?',
    kinds: [k('live', 'T19.4')], gaps: ['G16'], scopes: ['tenant'], dimensions: ['agent_family'] }),
  security({ id: 'S22', rank: 24, auditor: 'yes',
    title: 'Which MCP servers are configured and used by agents, and did any send data out?',
    kinds: [k('live', 'T19.4')], gaps: ['G15'], scopes: ['tenant'], dimensions: ['agent_family'] }),
  security({ id: 'S24', rank: 25, auditor: 'yes',
    title: 'What did we block, under which settings version, and what did the developer do next?',
    kinds: [k('live', 'T19.4')], gaps: ['G17'], scopes: ['tenant'], dimensions: ['rule', 'agent_family'] }),
  security({ id: 'S25', rank: 26, auditor: 'yes',
    title: 'Give me a signed incident case for one session.',
    kinds: [k('signed', null)], scopes: ['tenant'], phase: 2 }),
];

export const QA_QUESTIONS_BY_ID: ReadonlyMap<string, QaQuestion> = new Map(QA_QUESTIONS.map((q) => [q.id, q]));

/** CUSTOMER_AUDITOR_QA.md "Gaps found" (owners confirmed in T19.1). Every gap is open today. */
export const QA_GAPS: readonly QaGap[] = [
  { id: 'G1', title: 'Repository and path line-count snapshot', owner: 'Task2 + GitAI', open: true, questions: ['Q1'] },
  { id: 'G2', title: 'Organization AI-usage policy (approved tools and models)', owner: 'Task6.b', open: true, questions: ['Q4', 'Q12', 'S13'] },
  { id: 'G3', title: 'Pull request review and approval capture', owner: 'Task2 (semantics), Task7 (other providers), Task4 (delivery)', open: true, questions: ['Q5'] },
  { id: 'G4', title: 'merged_by on pull requests', owner: 'Task2', open: false, questions: ['Q6'] },
  { id: 'G5', title: 'Content-free rejection audit event for refused uploads', owner: 'Task4 (capture), Task16 (expose), Task15 (count)', open: false, questions: ['Q15'] },
  { id: 'G6', title: 'Security findings signed on their own (finding_observed)', owner: 'Task15 (Task15o), Task6 (outbox row)', open: true, questions: ['S1', 'S5', 'S7', 'S10', 'S11', 'S12'] },
  { id: 'G7', title: 'Monitoring coverage history', owner: 'Task6 + Task9 (capture), Task15 (signed)', open: true, questions: ['S2', 'S10'] },
  { id: 'G8', title: 'Security-monitor setting writer and audit event', owner: 'Task6 (writer), Task16 (event)', open: true, questions: ['S3'] },
  { id: 'G9', title: 'Rule coverage beyond three execution rules', owner: 'Task6.a (rule selection overseen by T19.7)', open: true, questions: ['S1', 'S3', 'S4'] },
  { id: 'G10', title: 'Model and session key on a finding', owner: 'Task6 + Task2', open: true, questions: ['Q11', 'S5', 'S6', 'S8'] },
  { id: 'G11', title: 'D6.1 activation lease issue and refuse events', owner: 'Task6.b', open: true, questions: ['S13'] },
  { id: 'G12', title: 'Policy exceptions and waivers', owner: 'Task6.b', open: true, questions: ['S14'] },
  { id: 'G13', title: 'Finding triage, disposition and remediation state', owner: 'Task6 (state), Task16 (event), Task10 (UI)', open: true, questions: ['S16', 'S18'] },
  { id: 'G14', title: 'Agent inventory and day-one scan uploads from the endpoint', owner: 'Task20 (Task20h-b)', open: true, questions: ['S19', 'S20'] },
  { id: 'G15', title: 'MCP server configuration and per-call MCP identity on findings', owner: 'Task20 (later)', open: true, questions: ['S22'] },
  { id: 'G16', title: 'Deferred rule wave 2 (the 7 normal-development rules, including exec.agent_runtime_bypass_flags)', owner: 'Task20 (later wave)', open: true, questions: ['S21'] },
  { id: 'G17', title: 'Opt-in blocking pilot (enforcement decisions)', owner: 'Task20 (Task20k)', open: true, questions: ['S24'] },
];

export const QA_GAPS_BY_ID: ReadonlyMap<string, QaGap> = new Map(QA_GAPS.map((g) => [g.id, g]));

/** The open gaps of a question, in registry order. */
export function openGapsOf(question: QaQuestion): QaGapId[] {
  return question.gaps.filter((id) => QA_GAPS_BY_ID.get(id)?.open === true);
}
