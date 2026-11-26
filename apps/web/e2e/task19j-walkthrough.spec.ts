/**
 * IT-T19j-01: one founder run over every answer that is built but was only unit-tested
 * (🟡 on docs/plan/CUSTOMER_AUDITOR_QA.md before Task19j), plus the five Task19j answers
 * (S2, S3, S4, S10's machines with no finding, S13's lease half), on the same seeded
 * throwaway stack as IT-T19i-01 (apps/api/src/features/qa/testing/task19i-walkthrough-seed.ts).
 *
 * Each test asserts what the Questions screen shows: badges, figures, unavailable states
 * (never a number) with their reason text, evidence lines and signed digests. Runs after
 * task19-walkthrough.spec.ts in the same `npm run e2e:task19-walkthrough`.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  answerBodies, answerCard, answerLoaded, apiAnswer, caveats, expectUnavailableFigure, figure, figureBadge, figureValue,
  last30, manifest, openQuestion, signIn,
} from './walkthrough-helpers';

const num = async (page: Page, label: string): Promise<number> => Number((await figureValue(page, label)).replace(/,/g, ''));
const evidenceLine = /^\d+ signed evidence records$/;
/** The screen's reason lines (questions-presentation.tsx QA_REASON_MESSAGES): one must explain every unavailable figure. */
const REASON_LINE = new RegExp([
  'This information is not being captured yet', 'This platform or activity is not monitored',
  'The provider does not report this information', 'This value is never written by the current system',
  'Some related records cannot be linked with confidence', 'This answer has not been built yet',
  'This question is planned for a later phase', 'security data settings keep this information',
  'No approval decisions were recorded', 'not sealed yet', 'report',
].join('|'));

/** Every figure card: a number, or "Not available" with a reason line and no number. */
async function everyFigureHonest(page: Page): Promise<void> {
  const cards = answerCard(page).locator('article');
  expect(await cards.count()).toBeGreaterThan(0);
  for (const card of await cards.all()) {
    const badge = (await card.locator('h4 + span').innerText()).trim();
    if (badge === 'Not available') {
      await expect(card.locator('div.text-2xl')).toHaveCount(0);
      expect(await card.innerText()).toMatch(REASON_LINE);
    } else {
      await expect(card.locator('div.text-2xl')).toHaveCount(1);
    }
  }
}

/** A verifiable answer: every figure with a value names its signed evidence. */
async function everyFigureHasEvidence(page: Page): Promise<void> {
  for (const card of await answerCard(page).locator('article').all()) {
    if ((await card.locator('h4 + span').innerText()).trim() !== 'Not available') {
      await expect(card.getByText(evidenceLine)).toBeVisible();
    }
  }
}

async function expectSigned(page: Page, badges: string[] = ['Recorded', 'Partial']): Promise<void> {
  expect(badges).toContain(await answerLoaded(page));
  await expect(answerCard(page).getByText('Signed report')).toBeVisible();
  await expect(answerCard(page).getByText(/^sha256:[0-9a-f]{64}$/).first()).toBeVisible();
}

/** Expected machine-days per Company A machine, from enrolment to now (UTC days, as the answer counts). */
function expectedDays(enrolledAt: string): number {
  const day = 86_400_000;
  return Math.floor(Date.now() / day) - Math.floor(Date.parse(enrolledAt) / day) + 1;
}

test.describe('Admin A, Task19j: built answers', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => { page = await browser.newPage(); await signIn(page, manifest().users.adminA); });
  test.afterAll(async () => { await page.close(); });

  test('Q13 and Q9 live: evidence completeness and production', async () => {
    const m = manifest();
    for (const question of ['Q13', 'Q9']) {
      await openQuestion(page, { question, kind: 'live', repositoryId: m.companyA.repositoryId });
      await answerLoaded(page);
      await everyFigureHonest(page);
    }
  });

  test('Q14 live: the chain for one PR, prompt to deploy', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'Q14', kind: 'live', pullRequestId: m.companyA.pullRequestId });
    expect(await answerLoaded(page)).toBe('Recorded');
    expect(await num(page, 'commits')).toBe(1);
    expect(await num(page, 'sessions')).toBe(1);
    expect(await num(page, 'merged')).toBe(1);
    expect(await num(page, 'production ai lines')).toBe(40);
    await expect(caveats(page)).toContainText('metadata');
  });

  test('Q10 live: rework not recorded for this PR is unavailable, Churned is never written', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'Q10', kind: 'live', repositoryId: m.companyA.repositoryId });
    await answerLoaded(page);
    await expectUnavailableFigure(page, 'churned ai lines', 'never');
    await everyFigureHonest(page);
  });

  test('Q18 live: tokens the vendor does not report are unavailable, never zero', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'Q18', kind: 'live', repositoryId: m.companyA.repositoryId, breakdown: 'model' });
    await answerLoaded(page);
    for (const key of ['input tokens', 'output tokens']) {
      await expectUnavailableFigure(page, key, 'The provider does not report this information.');
    }
  });

  test('S8, S9, S11, S12, S17, S18 live', async () => {
    const m = manifest();
    const findings = m.expected.findingsInPeriod;
    await openQuestion(page, { question: 'S8', kind: 'live', breakdown: 'model' });
    await answerLoaded(page);
    expect(await num(page, 'findings')).toBe(findings);
    await expect(figure(page, 'findings').locator('[aria-label="findings breakdown"]')).toContainText(m.companyA.model);

    await openQuestion(page, { question: 'S9', kind: 'live', breakdown: 'operating_system' });
    await answerLoaded(page);
    expect(await num(page, 'findings')).toBe(findings);
    await expect(figure(page, 'findings').locator('[aria-label="findings breakdown"]')).toContainText('macos');

    await openQuestion(page, { question: 'S11', kind: 'live' });
    await answerLoaded(page);
    expect(await num(page, 'v2 unclassified')).toBe(findings);
    await expect(caveats(page)).toContainText('Requested actions are not confirmed outcomes');

    await openQuestion(page, { question: 'S12', kind: 'live' });
    await answerLoaded(page);
    expect(await num(page, 'denied by request')).toBe(0);
    await expectUnavailableFigure(page, 'blocked', 'This answer has not been built yet.');
    await expect(caveats(page)).toContainText('Observed in monitor mode; nothing was blocked.');

    await openQuestion(page, { question: 'S17', kind: 'live', breakdown: 'machine' });
    await answerLoaded(page);
    expect(await num(page, 'findings')).toBe(findings);
    await expect(figure(page, 'findings').locator('[aria-label="findings breakdown"]')).toContainText(m.coverage.machineIds[0]);

    await openQuestion(page, { question: 'S18', kind: 'live', breakdown: 'rule' });
    await answerLoaded(page);
    expect(await num(page, 'findings')).toBe(findings);
    await expectUnavailableFigure(page, 'noisy rules', 'This information is not being captured yet.');
  });
});

test.describe('Admin A, Task19j: new answers from the Task20 coverage data', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => { page = await browser.newPage(); await signIn(page, manifest().users.adminA); });
  test.afterAll(async () => { await page.close(); });

  test('S2: monitoring on, not reported, unvalidated platforms, continuity partial', async () => {
    const { coverage: c } = manifest();
    await openQuestion(page, { question: 'S2', kind: 'live', breakdown: 'machine' });
    expect(await answerLoaded(page)).toBe('Partial');
    expect(await num(page, 'machines enrolled')).toBe(c.machines);
    expect(await num(page, 'machines reporting')).toBe(c.machinesReporting);
    expect(await num(page, 'machines not reporting')).toBe(c.machinesNotReporting);
    expect(await num(page, 'machines monitoring on')).toBe(c.machinesMonitoringOn);
    expect(await num(page, 'machines health failed')).toBe(c.machinesHealthFailed);
    expect(await num(page, 'machines on unvalidated platforms')).toBe(c.machinesOnUnvalidatedPlatforms);
    // Not reported is never healthy: the continuity is a partial ratio, with the reason shown.
    const days = expectedDays(c.enrolledAt);
    const reported = c.reportedDaysByMachine.reduce((sum, n) => sum + n, 0);
    const expected = days * c.machines;
    expect(await figureValue(page, 'machine days reported'))
      .toBe(`${reported} / ${expected} (${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format((reported / expected) * 100)}%)`);
    expect(await figureBadge(page, 'machine days reported')).toBe('Partial');
    await expect(figure(page, 'machine days reported')).toContainText('This platform or activity is not monitored.');
    // The machine that never reported shows 0 of its days, as a fact.
    const bars = figure(page, 'machine days reported').locator('[aria-label="machine_days_reported breakdown"]');
    await expect(bars.locator('div', { hasText: c.machineIds[2] }).first()).toContainText(`0 / ${days} (0%)`);
    expect(await num(page, 'monitoring switched off')).toBe(c.monitoringSwitchedOff);
    await expect(caveats(page)).toContainText('Observed in monitor mode; nothing was blocked.');
  });

  test('S3: settings and monitor-mode changes, tamper findings, lease refusals; no person named', async () => {
    const { coverage: c, users } = manifest();
    await openQuestion(page, { question: 'S3', kind: 'live' });
    expect(await answerLoaded(page)).toBe('Recorded');
    expect(await num(page, 'monitor mode changes')).toBe(c.monitorModeChanges);
    expect(await num(page, 'monitoring switched off')).toBe(c.monitoringSwitchedOff);
    expect(await num(page, 'settings changes')).toBe(c.settingsChanges);
    expect(await num(page, 'tamper findings')).toBe(c.tamperFindings);
    expect(await num(page, 'lease refusals')).toBe(c.leaseRefusals);
    await expect(answerCard(page)).not.toContainText(users.adminA.subject);
  });

  test('S4: secret reads, exfiltration, and egress after a secret read only from sequence findings', async () => {
    const { coverage: c } = manifest();
    await openQuestion(page, { question: 'S4', kind: 'live' });
    expect(await answerLoaded(page)).toBe('Recorded');
    expect(await num(page, 'secret read findings')).toBe(c.secretReadFindings);
    expect(await num(page, 'exfiltration findings')).toBe(c.exfiltrationFindings);
    expect(await num(page, 'secret read then egress sequences')).toBe(c.secretThenEgressSequences);
    await expect(caveats(page)).toContainText('Requested actions are not confirmed outcomes');
  });

  test('S10: up to date against the newest signed bundle, for machines with no finding too', async () => {
    const { coverage: c } = manifest();
    await openQuestion(page, { question: 'S10', kind: 'live', breakdown: 'machine' });
    expect(await answerLoaded(page)).toBe('Partial');
    expect(await num(page, 'machines up to date')).toBe(c.machinesUpToDate);
    expect(await figureBadge(page, 'machines up to date')).toBe('Partial');
    expect(await num(page, 'machines not up to date')).toBe(c.machinesNotUpToDate);
    expect(await num(page, 'machines not reporting')).toBe(c.machinesNotReporting);
    expect(await num(page, 'bundle digests in force')).toBe(2);
    expect(await num(page, 'numbat versions in force')).toBe(2);
    // A3 has no finding at all and still appears, as not reporting.
    await expect(figure(page, 'machines not reporting').locator('[aria-label="machines_not_reporting breakdown"]'))
      .toContainText(c.machineIds[2]);
  });

  test('S13: the lease half answers; the organization-policy half stays G2', async () => {
    const m = manifest();
    const c = m.coverage;
    await openQuestion(page, { question: 'S13', kind: 'live' });
    expect(await answerLoaded(page)).toBe('Partial');
    expect(await num(page, 'machines with lease in force')).toBe(c.machinesWithLeaseInForce);
    expect(await num(page, 'machines without lease in force')).toBe(c.machinesWithoutLeaseInForce);
    expect(await num(page, 'bundles in force')).toBe(c.bundlesInForce);
    expect(await num(page, 'lease refusals')).toBe(c.leaseRefusals);
    expect(await num(page, 'findings under lease')).toBe(m.expected.findingsInPeriod);
    expect(await num(page, 'findings without lease')).toBe(0);
    await expectUnavailableFigure(page, 'organization policy in force', 'This information is not being captured yet.');
    await expect(figure(page, 'organization policy in force').getByRole('link', { name: 'G2' })).toBeVisible();
  });
});

test.describe('Auditor A, Task19j: verifiable and signed answers', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => { page = await browser.newPage(); await signIn(page, manifest().users.auditorA); });
  test.afterAll(async () => { await page.close(); });

  test('Q13, Q9, Q1: verifiable with evidence, then signed with the period report', async () => {
    const m = manifest();
    for (const question of ['Q13', 'Q9']) {
      await openQuestion(page, { question, kind: 'verifiable', repositoryId: m.companyA.repositoryId });
      await answerLoaded(page);
      await everyFigureHonest(page);
      await everyFigureHasEvidence(page);
    }
    for (const question of ['Q13', 'Q9', 'Q1']) {
      await openQuestion(page, { question, kind: 'signed', repositoryId: m.companyA.repositoryId, period: m.codeReport });
      await expectSigned(page);
      await expect(answerCard(page).getByText(m.codeReport.statementDigest)).toBeVisible();
      await everyFigureHonest(page);
    }
    expect(await num(page, 'ai lines changed')).toBe(40);
    await expectUnavailableFigure(page, 'ai share of repository', 'This information is not being captured yet.');
  });

  test('Q14, Q16, Q8 verifiable: statements behind one PR, an export, one commit', async () => {
    const m = manifest();
    await openQuestion(page, { question: 'Q14', kind: 'verifiable', pullRequestId: m.companyA.pullRequestId });
    expect(await answerLoaded(page)).toBe('Recorded');
    expect(await num(page, 'pr merged statements')).toBe(1);
    expect(await num(page, 'deployed statements')).toBe(1);
    await expect(figure(page, 'deployed statements').getByText(evidenceLine)).toBeVisible();

    await openQuestion(page, { question: 'Q16', kind: 'verifiable', repositoryId: m.companyA.repositoryId });
    expect(await answerLoaded(page)).toBe('Recorded');
    expect(await num(page, 'statements in scope')).toBeGreaterThan(0);
    await everyFigureHasEvidence(page);

    await openQuestion(page, { question: 'Q8', kind: 'verifiable', repositoryId: m.companyA.repositoryId, commitSha: m.companyA.aiCommitSha });
    expect(await answerLoaded(page)).toBe('Recorded');
    expect(await num(page, 'statements')).toBeGreaterThan(0);
    expect(await figureValue(page, 'first seen to signed ms')).toMatch(/^[\d,]+ ms$/);
    expect(await num(page, 'signed late statements')).toBe(0);
    await everyFigureHasEvidence(page);
  });

  test('S8, S9, S10, S11, S12: verifiable with seal evidence, then signed with the security report', async () => {
    const m = manifest();
    for (const question of ['S8', 'S9', 'S10', 'S11', 'S12']) {
      await openQuestion(page, { question, kind: 'verifiable' });
      await answerLoaded(page);
      await everyFigureHonest(page);
      await everyFigureHasEvidence(page);
      if (question === 'S10') {
        // Signed statements carry no status reports: not built here, never the closed G7.
        await expectUnavailableFigure(page, 'machines up to date', 'This answer has not been built yet.');
      }
      await openQuestion(page, { question, kind: 'signed', period: m.securityReport });
      // S11 signed: the security report carries no phase split, so all three figures are
      // unavailable while the verifiable answer counts them (recorded for the Task19 lead).
      await expectSigned(page, question === 'S11' ? ['Not available'] : undefined);
      if (question === 'S11') await expectUnavailableFigure(page, 'v2 unclassified', 'The provider does not report this information.');
      await expect(answerCard(page).getByText(m.securityReport.statementDigest)).toBeVisible();
      await everyFigureHonest(page);
    }
    // The last one opened is S12 signed: nothing is called blocked without an enforcement decision.
    await expectUnavailableFigure(page, 'blocked', 'This answer has not been built yet.');
  });

  test('S2, S3, S4, S13 are for administrators: the auditor gets 403 for live', async () => {
    for (const question of ['S2', 'S3', 'S4', 'S13']) {
      const direct = await apiAnswer(manifest().users.auditorA, question, { kind: 'live', ...last30() });
      expect(direct.status, question).toBe(403);
      expect(direct.body.code).toBe('QA_KIND_NOT_ALLOWED');
    }
  });
});

test.describe('Admin B, Task19j: isolation of the new answers', () => {
  test('Company B sees only its own machine; none of A\'s machines or audit events', async ({ browser }) => {
    const m = manifest();
    const page = await browser.newPage();
    await signIn(page, m.users.adminB);
    await openQuestion(page, { question: 'S2', kind: 'live', breakdown: 'machine' });
    await answerLoaded(page);
    expect(await num(page, 'machines enrolled')).toBe(1);
    await openQuestion(page, { question: 'S3', kind: 'live' });
    await answerLoaded(page);
    expect(await num(page, 'monitor mode changes')).toBe(0);
    expect(await num(page, 'lease refusals')).toBe(0);
    await page.close();
    for (const body of answerBodies(m.users.adminB.subject)) {
      for (const id of m.coverage.machineIds) expect(body).not.toContain(id);
    }
  });
});

test('Task19j throughout: no login, e-mail, domain, repository URL or file path in any answer', async () => {
  for (const body of answerBodies()) {
    expect(body).not.toMatch(/@|\.invalid|github\.com|task19i-company|walkthrough-(author|merger)|src\/[ab]\/feature\.ts/);
  }
});
