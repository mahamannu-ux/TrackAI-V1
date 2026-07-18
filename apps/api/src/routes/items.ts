import { Router, Request, Response } from 'express';
import { db } from '../db';
import { items, ssoTenants } from '../db/schema';
import { eq, and } from 'drizzle-orm';

const router = Router();

/**
 * Helper to fetch a tenant's master UUID based on the employee's email domain.
 */
async function getTenantIdFromUserEmail(email: string): Promise<string | null> {
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  const domain = parts[1].trim().toLowerCase();

  const [tenant] = await db
    .select({ id: ssoTenants.id })
    .from(ssoTenants)
    .where(eq(ssoTenants.domain, domain))
    .limit(1);

  return tenant ? tenant.id : null;
}

/**
 * GET /api/items
 * Returns only the items belonging to the authenticated user's organization workspace.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    // 1. Extract email from your active JWT authorization middleware payload
    const userEmail = (req as any).user?.email;

    if (!userEmail) {
      res.status(401).json({ error: 'Unauthorized: Missing user context' });
      return;
    }

    // 2. Resolve the unique workspace UUID for their employer company
    const tenantId = await getTenantIdFromUserEmail(userEmail);
    if (!tenantId) {
      res.status(403).json({ error: 'Forbidden: No tenant workspace registered for this domain' });
      return;
    }

    // 3. SECURE FIX: Filter the select query to prevent cross-tenant data leakage
    const organizationItems = await db
      .select()
      .from(items)
      .where(eq(items.tenantId, tenantId));

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
    const userEmail = (req as any).user?.email;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required and must be a string' });
      return;
    }

    if (!userEmail) {
      res.status(401).json({ error: 'Unauthorized: Missing user context' });
      return;
    }

    // Resolve workspace mapping context
    const tenantId = await getTenantIdFromUserEmail(userEmail);
    if (!tenantId) {
      res.status(403).json({ error: 'Forbidden: Cannot create items outside an assigned workspace' });
      return;
    }

    // SECURE FIX: Stamp the row with the user's workspace tenant identifier UUID
    const [newItem] = await db
      .insert(items)
      .values({
        name,
        tenantId // Ensure schema maps to camelCase or snake_case as required
      })
      .returning();

    res.status(201).json(newItem);
  } catch (error) {
    console.error('Failed to create item:', error);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

export default router;
