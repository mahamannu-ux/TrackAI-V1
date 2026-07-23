import { Router, Request, Response } from 'express';
import { validateMetricsBatch } from './decoder';
import { ingestMetricsBatch } from './service';

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
    const errors = await ingestMetricsBatch(req.tenantId, batch);
    res.status(200).json({ errors });
  } catch (error) {
    console.error('Git AI metrics ingestion failed');
    res.status(503).json({ error: 'Metrics ingestion is temporarily unavailable' });
  }
});

export default router;
