import { Router, type Request, type Response } from 'express';
import { requireAdminAction } from '../../core/middleware/admin';
import { validateOpenCodeEvidenceBatch } from './contract';
import {
  correctIntention,
  evidenceGraph,
  evidenceSettings,
  enqueueSemanticReindex,
  explainCommit,
  frictionAnalytics,
  ingestOpenCodeEvidence,
  purgeExpiredEvidence,
  readRawEvidence,
  searchIntentions,
  semanticHealth,
  setEvidenceConsent,
} from './service';
import { SemanticUnavailableError } from './semantic';

export const evidenceWorkerRouter = Router();
export const evidenceReadRouter = Router();
export const evidenceAdminRouter = Router();

function tenant(req: Request, res: Response): string | null {
  if (!req.tenantId) {
    res.status(503).json({ error: 'Tenant context was not initialized' });
    return null;
  }
  return req.tenantId;
}

evidenceWorkerRouter.post('/opencode/batches', async (req, res) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  if (req.managedMachineCredential && !req.machineId) {
    res.status(503).json({ error: 'Managed machine context was not initialized' });
    return;
  }
  let batch;
  try {
    batch = validateOpenCodeEvidenceBatch(req.body);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid evidence batch' });
    return;
  }
  try {
    const result = await ingestOpenCodeEvidence({
      tenantId,
      machineId: req.managedMachineCredential ? req.machineId : undefined,
      batch,
    });
    res.status(202).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('not enabled')) {
      res.status(403).json({ error: 'OpenCode evidence collection is not enabled for this tenant' });
      return;
    }
    if (message.includes('tenant') || message.includes('grant')) {
      res.status(403).json({ error: 'Evidence repository access is not authorized' });
      return;
    }
    console.error('OpenCode evidence ingestion failed');
    res.status(503).json({ error: 'Evidence ingestion is temporarily unavailable' });
  }
});

const ROOT_TYPES = new Set(['commit', 'session', 'intention', 'event', 'trace', 'checkpoint']);

evidenceReadRouter.get('/graph', async (req, res) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  const rootType = String(req.query.rootType ?? '');
  const rootId = String(req.query.rootId ?? '');
  if (!ROOT_TYPES.has(rootType) || !rootId || rootId.length > 500) {
    res.status(400).json({ error: 'A supported rootType and rootId are required' });
    return;
  }
  const cursor = req.query.cursor === undefined ? 0 : Number(req.query.cursor);
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  const line = req.query.line === undefined ? undefined : Number(req.query.line);
  if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1
    || (line !== undefined && (!Number.isInteger(line) || line < 1))) {
    res.status(400).json({ error: 'cursor, limit, and line must be valid integers' });
    return;
  }
  try {
    res.json(await evidenceGraph({
      tenantId,
      rootType: rootType as 'commit' | 'session' | 'intention' | 'event' | 'trace' | 'checkpoint',
      rootId,
      path: typeof req.query.path === 'string' ? req.query.path : undefined,
      line,
      cursor,
      limit,
    }));
  } catch {
    console.error('Evidence graph query failed');
    res.status(503).json({ error: 'Evidence graph is temporarily unavailable' });
  }
});

evidenceReadRouter.get('/commits/:id/explain', async (req, res) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    const result = await explainCommit(tenantId, String(req.params.id));
    if (!result) { res.status(404).json({ error: 'Commit was not found' }); return; }
    res.json(result);
  } catch {
    console.error('Evidence explanation query failed');
    res.status(503).json({ error: 'Evidence explanation is temporarily unavailable' });
  }
});

evidenceReadRouter.get('/search', async (req, res) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (query.length < 2 || query.length > 500) {
    res.status(400).json({ error: 'Search query must contain between 2 and 500 characters' });
    return;
  }
  try {
    const filter = (name: string) => {
      const value = req.query[name];
      return typeof value === 'string' && value.length <= 500 ? value : undefined;
    };
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
      return;
    }
    res.json({ query, results: await searchIntentions(tenantId, query, {
      limit,
      repositoryId: filter('repositoryId'),
      commitId: filter('commitId'),
      sessionId: filter('sessionId'),
      tool: filter('tool'),
      model: filter('model'),
      path: filter('path'),
    }) });
  } catch (error) {
    if (error instanceof SemanticUnavailableError) {
      res.status(503).json({
        error: 'Semantic search is unavailable because the local model is not ready',
        code: error.code,
      });
      return;
    }
    console.error('Evidence search failed');
    res.status(503).json({ error: 'Evidence search is temporarily unavailable' });
  }
});

evidenceReadRouter.get('/analytics/friction', async (req, res) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    res.json({ sessions: await frictionAnalytics(tenantId) });
  } catch {
    console.error('Evidence friction analytics failed');
    res.status(503).json({ error: 'Evidence analytics are temporarily unavailable' });
  }
});

evidenceReadRouter.get(
  '/events/:id/raw',
  requireAdminAction('evidence.raw.read'),
  async (req, res) => {
    const tenantId = tenant(req, res); if (!tenantId) return;
    const actorId = req.user?.sub;
    if (!actorId) { res.status(401).json({ error: 'Authenticated user is required' }); return; }
    try {
      const result = await readRawEvidence({ tenantId, eventId: String(req.params.id), actorId });
      if (!result) { res.status(404).json({ error: 'Evidence event was not found' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch {
      console.error('Raw evidence retrieval failed');
      res.status(503).json({ error: 'Raw evidence is temporarily unavailable' });
    }
  },
);

evidenceAdminRouter.get('/settings', requireAdminAction('evidence.raw.read'), async (req, res) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    res.json(await evidenceSettings(tenantId));
  } catch {
    res.status(503).json({ error: 'Evidence settings are temporarily unavailable' });
  }
});

evidenceAdminRouter.put('/settings', requireAdminAction('evidence.consent.manage'), async (req, res) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  const actorId = req.user?.sub;
  if (!actorId) { res.status(401).json({ error: 'Authenticated user is required' }); return; }
  if (typeof req.body?.rawCollectionEnabled !== 'boolean') {
    res.status(400).json({ error: 'rawCollectionEnabled must be a boolean' });
    return;
  }
  try {
    res.json(await setEvidenceConsent({
      tenantId, actorId, enabled: req.body.rawCollectionEnabled,
    }));
  } catch {
    console.error('Evidence consent update failed');
    res.status(503).json({ error: 'Evidence consent is temporarily unavailable' });
  }
});

evidenceAdminRouter.post('/purge-expired', requireAdminAction('evidence.consent.manage'), async (req, res) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  const actorId = req.user?.sub;
  if (!actorId) { res.status(401).json({ error: 'Authenticated user is required' }); return; }
  try {
    res.json(await purgeExpiredEvidence(tenantId, actorId));
  } catch {
    console.error('Evidence retention purge failed');
    res.status(503).json({ error: 'Evidence retention is temporarily unavailable' });
  }
});

evidenceAdminRouter.get('/semantic-health', requireAdminAction('evidence.raw.read'), async (req, res) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  try {
    res.json(await semanticHealth(tenantId));
  } catch {
    console.error('Evidence semantic health query failed');
    res.status(503).json({ error: 'Evidence semantic health is temporarily unavailable' });
  }
});

evidenceAdminRouter.post('/semantic-reindex', requireAdminAction('evidence.consent.manage'), async (req, res) => {
  const tenantId = tenant(req, res); if (!tenantId) return;
  const actorId = req.user?.sub;
  if (!actorId) { res.status(401).json({ error: 'Authenticated user is required' }); return; }
  try {
    res.status(202).json(await enqueueSemanticReindex({ tenantId, actorId }));
  } catch {
    console.error('Evidence semantic reindex failed');
    res.status(503).json({ error: 'Evidence semantic reindex is temporarily unavailable' });
  }
});

evidenceAdminRouter.post(
  '/intentions/:id/corrections',
  requireAdminAction('evidence.correct'),
  async (req, res) => {
    const tenantId = tenant(req, res); if (!tenantId) return;
    const actorId = req.user?.sub;
    if (!actorId) { res.status(401).json({ error: 'Authenticated user is required' }); return; }
    if (typeof req.body?.value !== 'string' || typeof req.body?.reason !== 'string') {
      res.status(400).json({ error: 'Correction value and reason are required' });
      return;
    }
    try {
      const result = await correctIntention({
        tenantId,
        intentionId: String(req.params.id),
        actorId,
        value: req.body.value,
        reason: req.body.reason,
      });
      if (!result) { res.status(404).json({ error: 'Intention was not found' }); return; }
      res.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('invalid') || message.includes('required') || message.includes('Expired')) {
        res.status(400).json({ error: message });
        return;
      }
      console.error('Evidence intention correction failed');
      res.status(503).json({ error: 'Evidence correction is temporarily unavailable' });
    }
  },
);
