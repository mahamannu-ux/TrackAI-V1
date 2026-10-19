import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { db } from '../../core/db';
import { recordAuditEvent } from '../../core/audit/record';
import { decodeAttributes, validateMetricEvent, validateMetricsBatch } from './decoder';
import { canonicalRepositoryUrl } from './repository-url';
import type { GitAiMetricsBatch } from './types';
import type { RepositoryScopeError } from './repository-enforcement';
import { ingestMetricsBatch, validateBatchIngestionPolicy } from './service';
import {
  partitionAuthorizedMetricsBatch,
  remapAuthorizedUploadErrors,
} from './repository-enforcement';
import { validateClientDeliveryHealthReport } from '../../core/operations/client-delivery-health-contract';
import { recordClientDeliveryHealth } from '../../core/operations/client-delivery-health-service';

const router = Router();

const REJECTION_REASONS: Record<string, string> = {
  'Repository is required for managed machine telemetry': 'repository_missing',
  'Repository URL is invalid': 'repository_url_invalid',
  'Machine repository or branch grant is not active': 'grant_inactive',
  'Evidence predates the repository enrollment watermark': 'before_watermark',
};

export function rejectionAuditDetails(batch: GitAiMetricsBatch, errors: readonly RepositoryScopeError[], requestId?: string) {
  const reasonCounts: Record<string, number> = {
    repository_missing: 0, repository_url_invalid: 0, grant_inactive: 0, before_watermark: 0,
  };
  const digests = new Set<string>();
  for (const error of errors) {
    const reason = REJECTION_REASONS[error.error];
    if (!reason) throw new Error('Unknown repository rejection reason');
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    try {
      const event = validateMetricEvent(batch.events[error.index]);
      const url = decodeAttributes(event.a).repoUrl;
      if (url) digests.add(createHash('sha256').update(canonicalRepositoryUrl(url)).digest('hex'));
    } catch {
      // Invalid URLs and missing repositories have no canonical digest.
    }
  }
  return {
    event_count: errors.length,
    reason_counts: reasonCounts,
    repository_digests: [...digests].sort().slice(0, 20),
    ...(requestId && /^[A-Za-z0-9._-]{1,64}$/.test(requestId) ? { request_id: requestId } : {}),
  };
}

router.post('/delivery-health', async (req: Request, res: Response) => {
  if (!req.tenantId || !req.machineId || req.managedMachineCredential !== true) {
    res.status(403).json({ error: 'Managed machine authentication is required' });
    return;
  }
  const receivedAt = new Date();
  try {
    const report = validateClientDeliveryHealthReport(req.body, receivedAt);
    const result = await recordClientDeliveryHealth({
      tenantId: req.tenantId,
      machineId: req.machineId,
      report,
      receivedAt,
    });
    res.status(202).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid delivery health report';
    if (/report|timestamp|integer|field|oldestPendingAt|lastDeliveredAt/.test(message)) {
      res.status(400).json({ error: message });
      return;
    }
    console.error('Failed to record client delivery health');
    res.status(503).json({ error: 'Client delivery health is temporarily unavailable' });
  }
});

router.post('/metrics/upload', async (req: Request, res: Response) => {
  if (!req.tenantId) {
    res.status(503).json({ error: 'Tenant context was not initialized' });
    return;
  }
  if (req.managedMachineCredential && !req.machineId) {
    res.status(503).json({ error: 'Managed machine context was not initialized' });
    return;
  }

  let batch;
  try {
    batch = validateMetricsBatch(req.body);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request' });
    return;
  }

  try {
    const policy = await validateBatchIngestionPolicy(
      req.tenantId,
      batch,
      req.managedMachineCredential ? req.machineId : undefined,
    );
    if (req.machineId && policy.errors.length > 0) {
      await recordAuditEvent(db, req.tenantId, {
        action: 'telemetry.upload.rejected', actorType: 'machine', actorId: req.machineId,
        targetType: 'tenant', targetId: req.tenantId,
        details: rejectionAuditDetails(batch, policy.errors, req.get('x-request-id')),
      });
    }
    const authorized = partitionAuthorizedMetricsBatch(batch, policy.errors);
    const labelsByOriginalIndex = new Map(policy.labels.map((label) => [label.index, label]));
    const authorizedLabels = authorized.originalIndexes.flatMap((originalIndex, index) => {
      const label = labelsByOriginalIndex.get(originalIndex);
      return label ? [{ ...label, index }] : [];
    });
    const ingestErrors = authorized.batch.events.length > 0
      ? await ingestMetricsBatch(req.tenantId, authorized.batch, authorizedLabels)
      : [];
    const errors = remapAuthorizedUploadErrors(policy.errors, ingestErrors, authorized);
    res.status(200).json({ errors });
  } catch (error) {
    console.error('Git AI metrics ingestion failed');
    res.status(503).json({ error: 'Metrics ingestion is temporarily unavailable' });
  }
});

export default router;
