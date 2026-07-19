import { Router, Request, Response } from 'express';
import { db } from '../../core/db';
import { withTenant } from '../../core/db/tenant';
import { items } from '../../core/db/schema';

const router = Router();

/**
 * GET /api/items
 * Returns only the items belonging to the authenticated user's organization workspace.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(500).json({ error: 'Tenant context was not initialized' });
      return;
    }

    const tenantDb = withTenant(db, tenantId);
    const organizationItems = await tenantDb.select(items);

    res.json(organizationItems);
  } catch (error) {
    console.error('Failed to fetch items:', error);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

/**
 * POST /api/items
 * Creates a new item in the database, explicitly tagged to the user's organization.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    const tenantId = req.tenantId;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required and must be a string' });
      return;
    }

    if (!tenantId) {
      res.status(500).json({ error: 'Tenant context was not initialized' });
      return;
    }

    const tenantDb = withTenant(db, tenantId);
    const [newItem] = await tenantDb.insert(items, { name });

    res.status(201).json(newItem);
  } catch (error) {
    console.error('Failed to create item:', error);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

export default router;
