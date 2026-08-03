import 'dotenv/config';

import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../core/db';
import { evidenceExportJobs, ssoTenants } from '../../core/db/schema';
import { readTenantEvidenceExport } from '../../core/operations/evidence-export-service';
import { LocalFileEvidenceExportSink } from '../../core/operations/evidence-export-sink';
import { restoreTask4ExportEnvelope } from '../../core/operations/task4-export-format';

const companies = [
  { label: 'company_a', domain: 'purpletealabs.net' },
  { label: 'company_b', domain: 'customer-b-oidc.com' },
] as const;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const exportDirectory = process.env.TASK4_EXPORT_DIR;
  if (!exportDirectory) throw new Error('TASK4_EXPORT_DIR is required');
  const sink = new LocalFileEvidenceExportSink(exportDirectory);
  const tenants = await db.select({ id: ssoTenants.id, domain: ssoTenants.domain })
    .from(ssoTenants).where(inArray(
      ssoTenants.domain, companies.map(company => company.domain),
    ));
  if (tenants.length !== companies.length) throw new Error('Both logical tenants are required');

  const jobs = [];
  for (const company of companies) {
    const tenant = tenants.find(row => row.domain.toLowerCase() === company.domain);
    if (!tenant) throw new Error(`${company.label} tenant is missing`);
    const [job] = await db.select({ id: evidenceExportJobs.id }).from(evidenceExportJobs).where(and(
      eq(evidenceExportJobs.tenantId, tenant.id),
      eq(evidenceExportJobs.status, 'completed'),
      eq(evidenceExportJobs.archivePurpose, true),
    )).orderBy(desc(evidenceExportJobs.completedAt)).limit(1);
    if (!job) throw new Error(`${company.label} completed export is missing`);

    const result = await readTenantEvidenceExport({
      tenantId: tenant.id,
      exportJobId: job.id,
      sink,
    });
    const restored = restoreTask4ExportEnvelope(result.content);
    if (restored.manifest.tenantId !== tenant.id) {
      throw new Error(`${company.label} download returned another tenant's artifact`);
    }
    jobs.push({ company, tenant, job });
    console.log(`${company.label}.authorized_download=restored-and-checksummed`);
  }

  for (let index = 0; index < jobs.length; index += 1) {
    const own = jobs[index];
    const other = jobs[(index + 1) % jobs.length];
    try {
      await readTenantEvidenceExport({
        tenantId: own.tenant.id,
        exportJobId: other.job.id,
        sink,
      });
      throw new Error(`${own.company.label} unexpectedly downloaded another tenant's export`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('unexpectedly downloaded')) throw error;
      if (!(error instanceof Error) || !error.message.includes('was not found')) throw error;
    }
    console.log(`${own.company.label}.cross_tenant_download=blocked`);
  }

  console.log('logical_tenants=2');
  console.log('download_authorization=tenant-bound');
  console.log('artifact_integrity=verified-before-release');
  console.log('raw_payloads_credentials_secrets_prompts=not-printed');
  console.log('database_changes=none');
  console.log('download_verification=passed');
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Wave 5 export download verification failed');
  process.exitCode = 1;
});
