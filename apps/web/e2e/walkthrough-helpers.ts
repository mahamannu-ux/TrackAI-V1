/**
 * Shared helpers for the T19.9 walkthrough specs (IT-T19i-01 task19-walkthrough.spec.ts and
 * IT-T19j-01 task19j-walkthrough.spec.ts): the seeded manifest, sign-in through the real login
 * page, opening a question through the Questions screen's URL state, and figure locators.
 * Moved here from task19-walkthrough.spec.ts by Task19j, unchanged apart from the exports.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Locator, type Page, type Response } from '@playwright/test';

export interface User { subject: string; email: string; password: string }
export interface Manifest {
  companyA: { tenantId: string; repositoryId: string; repositoryName: string; pullRequestId: string; model: string; tool: string; aiCommitSha: string };
  companyB: { tenantId: string; repositoryId: string };
  codeReport: { from: string; to: string; statementDigest: string };
  securityReport: { from: string; to: string; statementDigest: string };
  expected: {
    permissionApproved: number; permissionDenied: number; permissionRequested: number;
    machinesReporting: number; agentsDetected: number; agentsWired: number;
    findingsInPeriod: number; findingsPreviousPeriod: number; highOrCriticalInReport: number;
  };
  users: { adminA: User; auditorA: User; adminB: User; auditorB: User };
  /** Task19j: Company A's coverage world (see seedCoverage in the seed). */
  coverage: {
    enrolledAt: string; machines: number; machineIds: string[]; reportedDaysByMachine: number[];
    machinesReporting: number; machinesNotReporting: number; machinesMonitoringOn: number; machinesHealthFailed: number;
    machinesOnUnvalidatedPlatforms: number; machinesUpToDate: number; machinesNotUpToDate: number;
    monitorModeChanges: number; monitoringSwitchedOff: number; settingsChanges: number; leaseRefusals: number;
    tamperFindings: number; secretReadFindings: number; exfiltrationFindings: number; secretThenEgressSequences: number;
    machinesWithLeaseInForce: number; machinesWithoutLeaseInForce: number; bundlesInForce: number;
  };
}

export const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run through npm run e2e:task19-walkthrough`);
  return value;
};
export const manifest = (): Manifest => JSON.parse(readFileSync(env('TASK19I_MANIFEST'), 'utf8')) as Manifest;
export const WEB = () => env('TASK19I_WEB_URL');
export const API = () => env('TASK19I_API_URL');

// ---------------------------------------------------------------------------
// Helpers

/**
 * Every answer body the browser received, for the content check at the end. Kept in a file
 * beside the manifest, not in memory: Playwright restarts the worker after a failed step.
 */
export const bodiesFile = () => join(dirname(env('TASK19I_MANIFEST')), 'answer-bodies.jsonl');
export const answerBodies = (subject?: string): string[] => (existsSync(bodiesFile())
  ? readFileSync(bodiesFile(), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { user: string; body: string })
  : []).filter((x) => !subject || x.user === subject).map((x) => x.body);

export async function signIn(page: Page, user: User): Promise<void> {
  page.on('response', (response: Response) => {
    if (/\/api\/qa\/questions\/[A-Z0-9]+\/answer/.test(response.url()) && response.request().method() === 'GET') {
      void response.text().then((body) => appendFileSync(bodiesFile(), `${JSON.stringify({ user: user.subject, body })}\n`)).catch(() => undefined);
    }
  });
  await page.goto(`${WEB()}/login`);
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/dashboard/);
}

/** A bearer token for a direct API call, from the same stub the browser signs in with. */
export async function token(user: User): Promise<string> {
  const res = await fetch(`${env('TASK19I_AUTH_URL')}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: user.password }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** A Q&A response body, loosely typed: the steps read only a few fields. */
export interface AnswerBody {
  availability?: string; code?: string;
  reasons: Array<{ code: string }>; figures: Array<{ value: unknown }>;
}

export async function apiAnswer(user: User, question: string, params: Record<string, string>): Promise<{ status: number; body: AnswerBody }> {
  const res = await fetch(`${API()}/api/qa/questions/${question}/answer?${new URLSearchParams(params)}`,
    { headers: { authorization: `Bearer ${await token(user)}` } });
  return { status: res.status, body: (await res.json()) as AnswerBody };
}

export const last30 = () => ({ from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date().toISOString() });

export interface Open {
  question: string;
  kind?: 'live' | 'verifiable' | 'signed';
  /** Default: Last 30 days. */
  period?: { from: string; to: string };
  repositoryId?: string;
  breakdown?: string;
  /** Task19j: pull-request scope (Q14), or commit scope with repositoryId (Q8). */
  pullRequestId?: string;
  commitSha?: string;
}

/** Opens the Questions screen on one question through its URL state, as a bookmark would. */
export async function openQuestion(page: Page, o: Open): Promise<void> {
  const p = new URLSearchParams({ view: 'questions', qaQuestion: o.question });
  if (o.kind) p.set('qaKind', o.kind);
  if (o.period) { p.set('qaPeriod', 'custom'); p.set('qaFrom', o.period.from); p.set('qaTo', o.period.to); } else p.set('qaPeriod', '30');
  p.set('qaScope', o.pullRequestId ? 'pull_request' : o.commitSha ? 'commit' : o.repositoryId ? 'repository' : 'tenant');
  if (o.repositoryId) p.set('qaRepository', o.repositoryId);
  if (o.pullRequestId) p.set('qaPullRequest', o.pullRequestId);
  if (o.commitSha) p.set('qaCommit', o.commitSha);
  if (o.breakdown) p.set('qaBreakdown', o.breakdown);
  await page.goto(`${WEB()}/dashboard?${p.toString()}`);
  await expect(page.locator('section[aria-label="Question answer"] h2')).toBeVisible();
  await expect(page.locator('section[aria-label="Question answer"]').getByText(`${o.question} ·`, { exact: false })).toBeVisible();
}

export const answerCard = (page: Page): Locator => page.locator('section[aria-label="Question answer"] > div').last();

/** Waits for the answer to load and returns its availability badge text. */
export async function answerLoaded(page: Page): Promise<string> {
  const card = answerCard(page);
  await expect(card.getByText('Loading answer…')).toHaveCount(0);
  await expect(card.getByText(/^As of /)).toBeVisible();
  return (await card.locator('h3 + span').innerText()).trim();
}

/** The figure card titled with the figure key (underscores as spaces) or its plain label. */
export const figure = (page: Page, label: string): Locator =>
  answerCard(page).locator('article').filter({ has: page.locator('h4', { hasText: new RegExp(`^${label}$`) }) });

export async function figureValue(page: Page, label: string): Promise<string> {
  const card = figure(page, label);
  await expect(card).toHaveCount(1);
  return (await card.locator('div.text-2xl, p.text-rose-200').first().innerText()).trim();
}

export const figureBadge = async (page: Page, label: string): Promise<string> => (await figure(page, label).locator('h4 + span').innerText()).trim();

export async function expectUnavailableFigure(page: Page, label: string, reason: string): Promise<void> {
  const card = figure(page, label);
  await expect(card).toHaveCount(1);
  await expect(card.locator('h4 + span')).toHaveText('Not available');
  await expect(card.getByText('Not available', { exact: true }).last()).toBeVisible();
  await expect(card.locator('div.text-2xl')).toHaveCount(0); // never a number, never zero
  await expect(card.getByText(reason, { exact: false })).toBeVisible();
}

export const caveats = (page: Page): Locator => answerCard(page).locator('h4', { hasText: 'Caveats' }).locator('xpath=following-sibling::ul');

export async function kindOptions(page: Page): Promise<Array<{ value: string; disabled: boolean }>> {
  return page.locator('label', { hasText: 'Answer type' }).locator('select option').evaluateAll((options) =>
    options.map((o) => ({ value: (o as HTMLOptionElement).value, disabled: (o as HTMLOptionElement).disabled })));
}

