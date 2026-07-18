import { Router, Request, Response } from 'express';
import { db } from '../db';
import { items } from '../db/schema';

const router = Router();

/**
 * GET /api/items
 * Returns all items from the database.
 * Protected by JWT middleware — only authenticated users can access.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const allItems = await db.select().from(items);
    res.json(allItems);
  } catch (error) {
    console.error('Failed to fetch items:', error);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

/**
 * POST /api/items
 * Creates a new item in the database.
 * Expects: { name: string } in the request body.
 * Protected by JWT middleware — only authenticated users can access.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required and must be a string' });
      return;
    }

    const [newItem] = await db.insert(items).values({ name }).returning();
    res.status(201).json(newItem);
  } catch (error) {
    console.error('Failed to create item:', error);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

export default router;
