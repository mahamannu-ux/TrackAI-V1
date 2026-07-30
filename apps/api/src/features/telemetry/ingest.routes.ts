import { Router, Request, Response } from 'express';
import { validateMetricsBatch } from './decoder';
import { ingestMetricsBatch, validateBatchRepositoryScope } from './service';

const router = Router();

router.post('/metrics/upload', async (req: Request, res: Response) => {
  if (!req.tenantId) {
    res.status(503).json({ error: 'Tenant context was not initialized' });
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
    const scopeErrors = await validateBatchRepositoryScope(req.tenantId, batch);
    if (scopeErrors.length > 0) {
      // Acknowledge indexed poison events without retaining their raw payload
      // in the wrong tenant. Task4 adds durable quarantine and partial-batch
      // processing; Task2 deliberately fails the complete batch closed.
      res.status(200).json({ errors: scopeErrors });
      return;
    }
    const errors = await ingestMetricsBatch(req.tenantId, batch);
    res.status(200).json({ errors });
  } catch (error) {
    console.error('Git AI metrics ingestion failed');
    res.status(503).json({ error: 'Metrics ingestion is temporarily unavailable' });
  }
});

export default router;
