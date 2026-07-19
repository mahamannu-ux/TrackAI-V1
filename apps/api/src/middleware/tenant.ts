import { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { ssoTenants } from '../db/schema';

/**
 * Resolves the authenticated user's email domain to its workspace UUID.
 * This middleware must run after authenticateJWT.
 */
export async function tenantMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const email = req.user?.email;

  if (!email) {
    res.status(401).json({ error: 'Unauthorized: Missing user email' });
    return;
  }

  const emailParts = email.split('@');
  const domain = emailParts.length === 2
    ? emailParts[1].trim().toLowerCase()
    : '';

  if (!domain) {
    res.status(401).json({ error: 'Unauthorized: Invalid user email' });
    return;
  }

  try {
    const [tenant] = await db
      .select({ id: ssoTenants.id })
      .from(ssoTenants)
      .where(eq(ssoTenants.domain, domain))
      .limit(1);

    if (!tenant) {
      res.status(403).json({
        error: 'Forbidden: No tenant workspace registered for this domain',
      });
      return;
    }

    req.tenantId = tenant.id;
    next();
  } catch (error) {
    console.error('Failed to resolve tenant:', error);
    res.status(500).json({ error: 'Failed to resolve tenant workspace' });
  }
}
