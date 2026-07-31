import { Router, Request, Response } from 'express';
import { validateMetricsBatch } from './decoder';
import { ingestMetricsBatch, validateBatchIngestionPolicy } from './service';
import {
  partitionAuthorizedMetricsBatch,
  remapAuthorizedUploadErrors,
} from './repository-enforcement';

const router = Router();

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
