/**
 * IT-T19i-01: the fifteen T19.9 steps (docs/plan/TASK19_WALKTHROUGH.md) on the seeded
 * world (apps/api/src/features/qa/testing/task19i-walkthrough-seed.ts), checked in the
 * real Questions screen: each step asserts what the screen shows (Task20j lesson), and
 * the API where the step names a status code. Throughout, no answer may carry a login,
 * an e-mail address, a domain, a repository URL or a file path.
 *
 *   npm run e2e:task19-walkthrough      (repository root; wraps scripts/it-db.sh)
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Locator, type Page, type Response } from '@playwright/test';

interface User { subject: string; email: string; password: string }
interface Manifest {
  companyA: { tenantId: string; repositoryId: string; repositoryName: string; pullRequestId: string; model: string; tool: string };
  companyB: { tenantId: string; repositoryId: string };
  codeReport: { from: string; to: string; statementDigest: string };
  securityReport: { from: string; to: string; statementDigest: string };
  expected: {
    permissionApproved: number; permissionDenied: number; permissionRequested: number;
    machinesReporting: number; agentsDetected: number; agentsWired: number;
    findingsInPeriod: number; findingsPreviousPeriod: number; highOrCriticalInReport: number;
  };
  users: { adminA: User; auditorA: User; adminB: User; auditorB: User };
}

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run through npm run e2e:task19-walkthrough`);
  return value;
};
const manifest = (): Manifest => JSON.parse(readFileSync(env('TASK19I_MANIFEST'), 'utf8')) as Manifest;
const WEB = () => env('TASK19I_WEB_URL');
const API = () => env('TASK19I_API_URL');

// ---------------------------------------------------------------------------
// Helpers

/**
 * Every answer body the browser received, for the content check at the end. Kept in a file
 * beside the manifest, not in memory: Playwright restarts the worker after a failed step.
 */
const bodiesFile = () => join(dirname(env('TASK19I_MANIFEST')), 'answer-bodies.jsonl');
const answerBodies = (subject?: string): string[] => (existsSync(bodiesFile())
  ? readFileSync(bodiesFile(), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { user: string; body: string })
  : []).filter((x) => !subject || x.user === subject).map((x) => x.body);

async function signIn(page: Page, user: User): Promise<void> {
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
async function token(user: User): Promise<string> {
  const res = await fetch(`${env('TASK19I_AUTH_URL')}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password: user.password }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** A Q&A response body, loosely typed: the steps read only a few fields. */
interface AnswerBody {
  availability?: string; code?: string;
  reasons: Array<{ code: string }>; figures: Array<{ value: unknown }>;
}

async function apiAnswer(user: User, question: string, params: Record<string, string>): Promise<{ status: number; body: AnswerBody }> {
  const res = await fetch(`${API()}/api/qa/questions/${question}/answer?${new URLSearchParams(params)}`,
    { headers: { authorization: `Bearer ${await token(user)}` } });
  return { status: res.status, body: (await res.json()) as AnswerBody };
}

const last30 = () => ({ from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date().toISOString() });

interface Open {
  question: string;
  kind?: 'live' | 'verifiable' | 'signed';
  /** Default: Last 30 days. */
  period?: { from: string; to: string };
  repositoryId?: string;
  breakdown?: string;
}

/** Opens the Questions screen on one question through its URL state, as a bookmark would. */
async function openQuestion(page: Page, o: Open): Promise<void> {
  const p = new URLSearchParams({ view: 'questions', qaQuestion: o.question });
  if (o.kind) p.set('qaKind', o.kind);
  if (o.period) { p.set('qaPeriod', 'custom'); p.set('qaFrom', o.period.from); p.set('qaTo', o.period.to); } else p.set('qaPeriod', '30');
  p.set('qaScope', o.repositoryId ? 'repository' : 'tenant');
  if (o.repositoryId) p.set('qaRepository', o.repositoryId);
  if (o.breakdown) p.set('qaBreakdown', o.breakdown);
  await page.goto(`${WEB()}/dashboard?${p.toString()}`);
  await expect(page.locator('section[aria-label="Question answer"] h2')).toBeVisible();
  await expect(page.locator('section[aria-label="Question answer"]').getByText(`${o.question} ·`, { exact: false })).toBeVisible();
}

const answerCard = (page: Page): Locator => page.locator('section[aria-label="Question answer"] > div').last();

/** Waits for the answer to load and returns its availability badge text. */
async function answerLoaded(page: Page): Promise<string> {
  const card = answerCard(page);
  await expect(card.getByText('Loading answer…')).toHaveCount(0);
  await expect(card.getByText(/^As of /)).toBeVisible();
  return (await card.locator('h3 + span').innerText()).trim();
}

/** The figure card titled with the figure key (underscores as spaces) or its plain label. */
const figure = (page: Page, label: string): Locator =>
  answerCard(page).locator('article').filter({ has: page.locator('h4', { hasText: new RegExp(`^${label}$`) }) });

async function figureValue(page: Page, label: string): Promise<string> {
  const card = figure(page, label);
  await expect(card).toHaveCount(1);
  return (await card.locator('div.text-2xl, p.text-rose-200').first().innerText()).trim();
}

const figureBadge = async (page: Page, label: string): Promise<string> => (await figure(page, label).locator('h4 + span').innerText()).trim();

async function expectUnavailableFigure(page: Page, label: string, reason: string): Promise<void> {
  const card = figure(page, label);
  await expect(card).toHaveCount(1);
  await expect(card.locator('h4 + span')).toHaveText('Not available');
  await expect(card.getByText('Not available', { exact: true }).last()).toBeVisible();
  await expect(card.locator('div.text-2xl')).toHaveCount(0); // never a number, never zero
  await expect(card.getByText(reason, { exact: false })).toBeVisible();
}

const caveats = (page: Page): Locator => answerCard(page).locator('h4', { hasText: 'Caveats' }).locator('xpath=following-sibling::ul');

async function kindOptions(page: Page): Promise<Array<{ value: string; disabled: boolean }>> {
  return page.locator('label', { hasText: 'Answer type' }).locator('select option').evaluateAll((options) =>
    options.map((o) => ({ value: (o as HTMLOptionElement).value, disabled: (o as HTMLOptionElement).disabled })));
}

// ---------------------------------------------------------------------------
// Steps, grouped by who is signed in; numbers are the walkthrough's.

test.describe('Admin A', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => { page = await browser.newPage(); await signIn(page, manifest().users.adminA); });
  test.afterAll(async () => { await page.close(); });

  test('step 1: Q3 live, merged AI lines with the model breakdown', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'Q3', kind: 'live', repositoryId: m.companyA.repositoryId, breakdown: 'model' });
    expect(['Recorded', 'Partial']).toContain(await answerLoaded(page));
    const merged = Number((await figureValue(page, 'merged ai lines')).replace(/,/g, ''));
    expect(merged).toBeGreaterThan(0);
    // The seed records a known model, so its bar must be there (never only `Unknown`).
    const bars = figure(page, 'merged ai lines').locator('[aria-label="merged_ai_lines breakdown"]');
    await expect(bars).toBeVisible();
    await expect(bars.getByText(m.companyA.model, { exact: false })).toBeVisible();
  });

  test('step 3: Q1 live, changed-lines share; repository share not captured (G1)', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'Q1', kind: 'live', repositoryId: m.companyA.repositoryId });
    await answerLoaded(page);
    expect(await figureValue(page, 'ai share of changed lines')).toMatch(/^[\d,]+ \/ [\d,]+ \([\d.]+%\)$/);
    await expectUnavailableFigure(page, 'ai share of repository', 'This information is not being captured yet.');
    await expect(figure(page, 'ai share of repository').getByRole('link', { name: 'G1' })).toBeVisible();
  });

  test('step 4: Q4 live, models and lines in production; approval not captured (G2)', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'Q4', kind: 'live', repositoryId: m.companyA.repositoryId });
    await answerLoaded(page);
    expect(Number(await figureValue(page, 'models in production'))).toBeGreaterThanOrEqual(1);
    expect(Number((await figureValue(page, 'production ai lines')).replace(/,/g, ''))).toBeGreaterThan(0);
    await expectUnavailableFigure(page, 'approved at the time', 'This information is not being captured yet.');
    await expect(figure(page, 'approved at the time').getByRole('link', { name: 'G2' })).toBeVisible();
  });

  test('step 5 (admin): Q11 live, with the partial session-link note', async () => {
    await openQuestion(page, { question: 'Q11', kind: 'live' });
    await answerLoaded(page);
    await expect(figure(page, 'findings in linked sessions')).toHaveCount(1);
    await expect(caveats(page)).toContainText('Links between sessions and findings are partial.');
  });

  test('step 8: S7 live, by repository, category and severity, with the previous period', async () => {
    const m = manifest();
    for (const [dimension, expected] of [
      ['severity', ['critical', 'high', 'medium', 'low']],
      ['rule_category', ['secrets', 'exec', 'network']],
      ['repository', [m.companyA.repositoryName]],
    ] as const) {
      await openQuestion(page, { question: 'S7', kind: 'live', breakdown: dimension });
      await answerLoaded(page);
      expect(Number(await figureValue(page, 'findings'))).toBe(m.expected.findingsInPeriod);
      const card = figure(page, 'findings');
      const previous = card.locator('div', { hasText: /^Previous period:/ }).last();
      await expect(previous).toBeVisible();
      await expect(previous.locator('span.text-slate-200')).toHaveText(String(m.expected.findingsPreviousPeriod));
      // The breakdown must be on screen, not only in the API (Task20j found it missing in the browser).
      const bars = card.locator('[aria-label="findings breakdown"]');
      await expect(bars, `S7 ${dimension} breakdown bars (needs the web answer request to send breakdown)`).toBeVisible();
      for (const key of expected) await expect(bars.getByText(key, { exact: true })).toBeVisible();
      await expect(caveats(page)).toContainText('Observed in monitor mode; nothing was blocked.');
    }
  });

  test('step 9: S19 live, the agent inventory', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'S19', kind: 'live' });
    await answerLoaded(page);
    expect(Number(await figureValue(page, 'machines reporting'))).toBeGreaterThanOrEqual(m.expected.machinesReporting);
    expect(Number(await figureValue(page, 'agents detected'))).toBe(m.expected.agentsDetected);
    expect(Number(await figureValue(page, 'agents wired'))).toBe(m.expected.agentsWired);
    await expectUnavailableFigure(page, 'agent versions', 'The provider does not report this information.');
    await expectUnavailableFigure(page, 'agents not on approved list', 'This information is not being captured yet.');
    await expect(figure(page, 'agents not on approved list').getByRole('link', { name: 'G2' })).toBeVisible();
  });

  test('step 10: S20 live, the day-one scan', async () => {
    await openQuestion(page, { question: 'S20', kind: 'live' });
    await answerLoaded(page);
    expect(Number(await figureValue(page, 'machines scanned'))).toBeGreaterThanOrEqual(1);
    expect(Number(await figureValue(page, 'findings at rest'))).toBe(1);
    // A scan that found no session files is its own figure, never a failure.
    expect(Number(await figureValue(page, 'scans with no session files found for this agent'))).toBe(1);
    expect(Number(await figureValue(page, 'scans failed'))).toBe(0);
    await expect(caveats(page)).toContainText('Requested actions are not confirmed outcomes');
  });

  test('step 11: S26 live, permission requests, approvals and denials', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'S26', kind: 'live' });
    await answerLoaded(page);
    expect(Number(await figureValue(page, 'permission approved'))).toBe(m.expected.permissionApproved);
    expect(Number(await figureValue(page, 'permission denied'))).toBe(m.expected.permissionDenied);
    expect(await figureValue(page, 'approval rate')).toBe('1 / 2 (50%)');
    expect(await figureBadge(page, 'sessions with finding and approval')).toBe('Partial');
    await expect(figure(page, 'sessions with finding and approval')).toContainText('Some related records cannot be linked with confidence.');
  });

  test('step 13: S3 live is not built, and is never shown as zero', async () => {
    await openQuestion(page, { question: 'S3' });
    const notBuilt = page.locator('h3', { hasText: 'Answers not built yet' }).locator('..');
    await expect(notBuilt).toBeVisible();
    await expect(notBuilt.getByText('live', { exact: true })).toBeVisible();
    await expect(notBuilt.getByText('Not built yet').first()).toBeVisible();
    await expect(answerCard(page).locator('article')).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(answerBodies(manifest().users.adminA.subject).some((b) => b.includes('"question_id":"S3"'))).toBe(false);
    // The API, asked directly, says so with the reason, and carries no figure at all.
    const direct = await apiAnswer(manifest().users.adminA, 'S3', { kind: 'live', ...last30() });
    expect(direct.status).toBe(200);
    expect(direct.body.availability).toBe('unavailable');
    expect(direct.body.reasons.map((r) => r.code)).toContain('answer_not_built');
    for (const f of direct.body.figures) expect(f.value).toBeNull();
  });
});

test.describe('Auditor A', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => { page = await browser.newPage(); await signIn(page, manifest().users.auditorA); });
  test.afterAll(async () => { await page.close(); });

  test('step 2: Q3 verifiable with statement evidence, then signed with the report digest; no live', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'Q3', kind: 'verifiable', repositoryId: m.companyA.repositoryId });
    await answerLoaded(page);
    expect((await kindOptions(page)).filter((o) => o.value === 'live' && !o.disabled)).toHaveLength(0);
    const merged = figure(page, 'merged ai lines');
    expect(Number((await figureValue(page, 'merged ai lines')).replace(/,/g, ''))).toBeGreaterThan(0);
    await expect(merged.getByText(/^\d+ signed evidence records$/)).toBeVisible();
    await expect(merged.getByRole('button', { name: 'Open Attestation' })).toBeVisible();

    await openQuestion(page, { question: 'Q3', kind: 'signed', repositoryId: m.companyA.repositoryId, period: m.codeReport });
    expect(await answerLoaded(page)).toBe('Recorded');
    await expect(answerCard(page).getByText('Signed report')).toBeVisible();
    await expect(answerCard(page).getByText(m.codeReport.statementDigest)).toBeVisible();
  });

  test('step 5 (auditor): Q11 verifiable, with evidence', async () => {
    await openQuestion(page, { question: 'Q11', kind: 'verifiable' });
    await answerLoaded(page);
    const card = answerCard(page).locator('article').first();
    await expect(card.getByText(/^\d+ signed evidence records$/)).toBeVisible();
  });

  test('step 6: Q7 verifiable, the chain is intact; there is no live kind', async () => {
    await openQuestion(page, { question: 'Q7', kind: 'verifiable' });
    expect(await answerLoaded(page)).toBe('Recorded');
    expect(Number(await figureValue(page, 'statements checked'))).toBeGreaterThan(0);
    expect(await figureValue(page, 'breaks')).toBe('0');
    await expect(figure(page, 'breaks').getByRole('button', { name: 'Open Attestation' })).toBeVisible();
    expect((await kindOptions(page)).map((o) => o.value)).not.toContain('live');
  });

  test('step 7: S1 verifiable register with the monitor-mode note, then the signed security report', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'S1', kind: 'verifiable' });
    await answerLoaded(page);
    expect(Number(await figureValue(page, 'high or critical findings'))).toBeGreaterThanOrEqual(m.expected.highOrCriticalInReport);
    await expect(figure(page, 'high or critical findings').getByText(/^\d+ signed evidence records$/)).toBeVisible();
    await expect(caveats(page)).toContainText('Observed in monitor mode; nothing was blocked.');

    await openQuestion(page, { question: 'S1', kind: 'signed', period: m.securityReport });
    expect(await answerLoaded(page)).toBe('Recorded');
    expect(Number(await figureValue(page, 'high or critical findings'))).toBe(m.expected.highOrCriticalInReport);
    await expect(answerCard(page).getByText(m.securityReport.statementDigest)).toBeVisible();
  });

  test('step 12: S19, S20 and S26 offer the auditor no answer; kind=live is 403', async () => {
    for (const question of ['S19', 'S20', 'S26']) {
      await openQuestion(page, { question });
      await expect(answerCard(page).locator('p', { hasText: 'Live answers are for administrators.' })).toBeVisible();
      const options = await kindOptions(page);
      expect(options.filter((o) => !o.disabled && o.value !== '')).toHaveLength(0);
      await expect(answerCard(page).locator('article')).toHaveCount(0);
      const direct = await apiAnswer(manifest().users.auditorA, question, { kind: 'live', ...last30() });
      expect(direct.status).toBe(403);
      expect(direct.body.code).toBe('QA_KIND_NOT_ALLOWED');
    }
  });
});

test.describe('Admin B', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => { page = await browser.newPage(); await signIn(page, manifest().users.adminB); });
  test.afterAll(async () => { await page.close(); });

  test('step 14: Q3, S19 and S26 show only Company B', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'Q3', kind: 'live', breakdown: 'repository' });
    await answerLoaded(page);
    await expect(answerCard(page).getByText(m.companyA.repositoryName)).toHaveCount(0);
    // Company B merged nothing: unavailable, never a zero.
    await expect(figure(page, 'merged ai lines')).toHaveCount(1);
    await expect(figure(page, 'merged ai lines').locator('h4 + span')).toHaveText('Not available');
    await expect(figure(page, 'merged ai lines').locator('div.text-2xl')).toHaveCount(0);

    await openQuestion(page, { question: 'S19', kind: 'live' });
    await answerLoaded(page);
    expect(Number(await figureValue(page, 'agents detected'))).toBe(1); // B's own one agent, not A's three

    await openQuestion(page, { question: 'S26', kind: 'live' });
    await answerLoaded(page);
    expect(await figureValue(page, 'permission approved')).toBe('0');
    expect(await figureValue(page, 'permission denied')).toBe('0');
    await expectUnavailableFigure(page, 'approval rate', 'No approval decisions were recorded in this period');

    const bodiesB = answerBodies(m.users.adminB.subject);
    expect(bodiesB.length).toBeGreaterThanOrEqual(3);
    for (const body of bodiesB) {
      expect(body).not.toContain(m.companyA.repositoryId);
      expect(body).not.toContain(m.companyA.tenantId);
    }
  });

  test('step 15: Company A\'s repository id is 404 QA_SCOPE_NOT_FOUND, exactly as an unknown id', async () => {
    const m = manifest();
    const foreign = await apiAnswer(m.users.adminB, 'Q3', { kind: 'live', repository_id: m.companyA.repositoryId, ...last30() });
    const unknown = await apiAnswer(m.users.adminB, 'Q3', { kind: 'live', repository_id: '00000000-0000-4000-8000-000000000000', ...last30() });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('QA_SCOPE_NOT_FOUND');
    expect(unknown.status).toBe(404);
    expect({ ...foreign.body, request_id: undefined }).toEqual({ ...unknown.body, request_id: undefined });
    expect(JSON.stringify(foreign.body)).not.toMatch(/figures|merged_ai_lines/);
    // The screen says so too, with no data.
    await openQuestion(page, { question: 'Q3', kind: 'live', repositoryId: m.companyA.repositoryId });
    await expect(answerCard(page).getByRole('alert')).toContainText('The selected repository, pull request, or commit was not found.');
    await expect(answerCard(page).locator('article')).toHaveCount(0);
  });
});

test('throughout: no login, e-mail, domain, repository URL or file path in any answer', async () => {
  expect(answerBodies().length).toBeGreaterThan(15);
  for (const body of answerBodies()) {
    expect(body).not.toMatch(/@|\.invalid|github\.com|task19i-company|walkthrough-(author|merger)|src\/[ab]\/feature\.ts/);
  }
});
