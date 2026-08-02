import 'dotenv/config';

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import {
  githubAppCredentialVersions,
  scmCommits,
  scmRepositories,
  securityAuditEvents,
  ssoTenants,
} from '../../core/db/schema';
import { loadGitHubAppRuntimeCredentials } from '../../core/security/github-app-security-service';
import { getRepositoryCommit } from '../scm/github-app';

const owners = ['mahamannu-ai', 'customer-b-corp-ai'] as const;

interface Fixture {
  tenantId: string;
  owner: string;
  repository: string;
  sha: string;
}

async function fixtureFor(owner: string): Promise<Fixture> {
  const [tenant] = await db.select({ id: ssoTenants.id })
    .from(ssoTenants)
    .where(sql`lower(${ssoTenants.scmOrgIdentifier}) = ${owner}`)
    .limit(1);
  if (!tenant) throw new Error(`Tenant fixture is missing for ${owner}`);
  const [row] = await db.select({
    normalizedUrl: scmRepositories.normalizedUrl,
    url: scmRepositories.url,
    sha: scmCommits.sha,
  }).from(scmCommits).innerJoin(scmRepositories, and(
    eq(scmRepositories.tenantId, scmCommits.tenantId),
    eq(scmRepositories.id, scmCommits.repositoryId),
  )).where(and(
    eq(scmCommits.tenantId, tenant.id),
    sql`lower(coalesce(${scmRepositories.normalizedUrl}, ${scmRepositories.url}))
      LIKE ${`github.com/${owner}/%`}`,
  )).orderBy(desc(scmCommits.committedAt), desc(scmCommits.createdAt)).limit(1);
  if (!row) throw new Error(`Commit fixture is missing for ${owner}`);
  const canonical = (row.normalizedUrl ?? row.url)
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '');
  const parts = canonical.split('/');
  if (parts.length !== 3 || parts[0].toLowerCase() !== 'github.com') {
    throw new Error(`Repository fixture is invalid for ${owner}`);
  }
  return { tenantId: tenant.id, owner, repository: parts[2], sha: row.sha };
}

async function main(): Promise<void> {
  const fixtures = await Promise.all(owners.map(fixtureFor));
  const priorEnvironment = {
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    installations: process.env.GITHUB_APP_INSTALLATIONS_JSON,
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
    installationToken: process.env.GITHUB_APP_INSTALLATION_TOKEN,
    publicRead: process.env.GITHUB_ALLOW_PUBLIC_READ,
  };
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  delete process.env.GITHUB_APP_INSTALLATIONS_JSON;
  delete process.env.GITHUB_APP_INSTALLATION_ID;
  delete process.env.GITHUB_APP_INSTALLATION_TOKEN;
  process.env.GITHUB_ALLOW_PUBLIC_READ = 'false';
  try {
    const credentials = await Promise.all(fixtures.map(fixture => (
      loadGitHubAppRuntimeCredentials(fixture.tenantId, fixture.owner)
    )));
    if (credentials.some(rows => rows.length !== 1 || rows[0].status !== 'active')) {
      throw new Error('Each tenant must resolve exactly one active managed credential');
    }
    const crossed = await Promise.all([
      loadGitHubAppRuntimeCredentials(fixtures[0].tenantId, fixtures[1].owner),
      loadGitHubAppRuntimeCredentials(fixtures[1].tenantId, fixtures[0].owner),
    ]);
    if (crossed.some(rows => rows.length !== 0)) {
      throw new Error('Cross-tenant GitHub credential resolution was not blocked');
    }
    const commits = await Promise.all(fixtures.map(fixture => getRepositoryCommit(
      fixture.tenantId,
      fixture.owner,
      fixture.repository,
      fixture.sha,
    )));
    if (commits.some((commit, index) => commit?.sha !== fixtures[index].sha)) {
      throw new Error('Managed GitHub commit read did not match existing evidence');
    }
    const crossRead = await getRepositoryCommit(
      fixtures[0].tenantId,
      fixtures[1].owner,
      fixtures[1].repository,
      fixtures[1].sha,
    );
    if (crossRead !== null) throw new Error('Cross-tenant GitHub read was not blocked');
    const audit = await db.select({ count: sql<number>`count(*)::int` })
      .from(securityAuditEvents).where(
        eq(securityAuditEvents.action, 'github_app.installation_created'),
      );
    const plaintext = await db.select({ count: sql<number>`count(*)::int` })
      .from(githubAppCredentialVersions).where(
        sql`${githubAppCredentialVersions.encryptedCredential}::text LIKE '%PRIVATE KEY%'`,
      );
    if ((audit[0]?.count ?? 0) < 2 || (plaintext[0]?.count ?? 0) !== 0) {
      throw new Error('GitHub credential audit or ciphertext storage verification failed');
    }
    console.log('logical_installations=2');
    console.log('environment_credential_fallback=disabled');
    console.log('managed_credentials=tenant-bound-and-decryptable');
    console.log('company_a_github_read=authenticated');
    console.log('company_b_github_read=authenticated');
    console.log('cross_tenant_credential_resolution=blocked-both-directions');
    console.log('cross_tenant_github_read=blocked');
    console.log('installation_audit=present');
    console.log('plaintext_private_keys_in_database=0');
    console.log('tokens_private_keys_payloads=never-printed');
    console.log('database_changes=none');
  } finally {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('GITHUB_APP_ID', priorEnvironment.appId);
    restore('GITHUB_APP_PRIVATE_KEY', priorEnvironment.privateKey);
    restore('GITHUB_APP_INSTALLATIONS_JSON', priorEnvironment.installations);
    restore('GITHUB_APP_INSTALLATION_ID', priorEnvironment.installationId);
    restore('GITHUB_APP_INSTALLATION_TOKEN', priorEnvironment.installationToken);
    restore('GITHUB_ALLOW_PUBLIC_READ', priorEnvironment.publicRead);
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Wave 4 GitHub verification failed');
  process.exitCode = 1;
});
