import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../../core/db';
import { ssoTenants } from '../../core/db/schema';
import { rebuildGenerationEvidence } from './service';

async function main() {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, '').split('=');
    return [key, value.join('=') || 'true'];
  }));
  const domain = args.get('tenant-domain')?.trim().toLowerCase();
  const repositoryUrl = args.get('repository-url')?.trim();
  const confirmed = args.get('confirm') === 'REBUILD_GENERATION';
  if (!domain) throw new Error('--tenant-domain=<domain> is required');
  if (!repositoryUrl) throw new Error('--repository-url=<url> is required');

  const [tenant] = await db.select({ id: ssoTenants.id, domain: ssoTenants.domain })
    .from(ssoTenants).where(eq(ssoTenants.domain, domain)).limit(1);
  if (!tenant) throw new Error(`No tenant found for ${domain}`);

  const result = await rebuildGenerationEvidence(tenant.id, repositoryUrl, confirmed);
  console.log(JSON.stringify({
    dryRun: !confirmed,
    tenant: tenant.domain,
    ...result,
    unit: 'physical_loc',
    ...(confirmed ? {} : {
      next: 'rerun with --confirm=REBUILD_GENERATION after reviewing the totals',
    }),
  }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
