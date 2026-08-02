import 'dotenv/config';

import { createSign } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../core/db';
import { githubAppInstallations, ssoTenants } from '../../core/db/schema';
import { githubAppPermissionsAreReadOnly } from '../../core/security/github-app-credential';
import { createGitHubAppInstallation } from '../../core/security/github-app-security-service';

interface GitHubInstallationResponse {
  id: number;
  account?: { login?: string };
  target_type?: string;
  permissions?: Record<string, string>;
  suspended_at?: string | null;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${base64Url(signer.sign(privateKey))}`;
}

function installationMap(): Array<{ owner: string; installationId: string }> {
  const raw = process.env.GITHUB_APP_INSTALLATIONS_JSON;
  if (!raw) throw new Error('GITHUB_APP_INSTALLATIONS_JSON is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GITHUB_APP_INSTALLATIONS_JSON must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GITHUB_APP_INSTALLATIONS_JSON must be an object');
  }
  const entries = Object.entries(parsed as Record<string, unknown>).map(([owner, id]) => ({
    owner: owner.trim().toLowerCase(),
    installationId: String(id),
  }));
  if (entries.length !== 2 || entries.some(entry => (
    !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(entry.owner)
    || !/^\d+$/.test(entry.installationId)
  ))) {
    throw new Error('Exactly two valid owner-to-installation mappings are required');
  }
  return entries.sort((left, right) => left.owner.localeCompare(right.owner));
}

async function main(): Promise<void> {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!appId || !/^\d+$/.test(appId)) throw new Error('GITHUB_APP_ID is required');
  if (!privateKey) throw new Error('GITHUB_APP_PRIVATE_KEY is required');
  const apply = process.env.TASK4_WAVE4_GITHUB_IMPORT_APPLY === '1';
  const jwt = appJwt(appId, privateKey);
  const validated: Array<{
    tenantId: string;
    tenantDomain: string;
    owner: string;
    installationId: string;
    permissions: Record<string, string>;
  }> = [];

  for (const entry of installationMap()) {
    const response = await fetch(
      `https://api.github.com/app/installations/${entry.installationId}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'TrackAI',
        },
      },
    );
    if (!response.ok) throw new Error(`GitHub installation validation failed (${response.status})`);
    const installation = await response.json() as GitHubInstallationResponse;
    const accountLogin = installation.account?.login?.toLowerCase();
    if (String(installation.id) !== entry.installationId || accountLogin !== entry.owner) {
      throw new Error('GitHub installation identity does not match its configured owner');
    }
    if (installation.target_type !== 'Organization' || installation.suspended_at) {
      throw new Error('GitHub installation must be an active organization installation');
    }
    const permissions = installation.permissions ?? {};
    if (!githubAppPermissionsAreReadOnly(permissions)) {
      throw new Error('GitHub installation permissions are missing required reads or include writes');
    }
    const [tenant] = await db.select({ id: ssoTenants.id, domain: ssoTenants.domain })
      .from(ssoTenants)
      .where(sql`lower(${ssoTenants.scmOrgIdentifier}) = ${entry.owner}`)
      .limit(1);
    if (!tenant) throw new Error('GitHub installation owner has no tenant mapping');
    const [existing] = await db.select({ id: githubAppInstallations.id })
      .from(githubAppInstallations).where(and(
        eq(githubAppInstallations.tenantId, tenant.id),
        eq(githubAppInstallations.installationExternalId, entry.installationId),
      )).limit(1);
    if (existing) throw new Error('GitHub installation is already imported');
    validated.push({
      tenantId: tenant.id,
      tenantDomain: tenant.domain,
      owner: entry.owner,
      installationId: entry.installationId,
      permissions,
    });
  }

  console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
  for (const entry of validated) {
    console.log(`${entry.owner}.tenant=${entry.tenantDomain}`);
    console.log(`${entry.owner}.installation_id=${entry.installationId}`);
    console.log(`${entry.owner}.permissions=read-only-verified`);
  }
  console.log('private_key=validated-not-printed');
  console.log('installation_tokens=not-created');
  if (!apply) {
    console.log('database_changes=none');
    console.log('next=rerun-with-explicit-apply-after-review');
    return;
  }

  for (const entry of validated) {
    await createGitHubAppInstallation({
      tenantId: entry.tenantId,
      appId,
      installationExternalId: entry.installationId,
      accountLogin: entry.owner,
      permissions: entry.permissions,
      subscribedEvents: [],
      privateKey,
      actorId: 'task4-wave4-system-import',
    });
  }
  console.log(`installations_imported=${validated.length}`);
  console.log(`credential_versions_created=${validated.length}`);
  console.log('audit_events=written');
  console.log('import=complete');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Wave 4 GitHub import failed');
  process.exitCode = 1;
});
