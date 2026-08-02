import type { NextFunction, Request, Response } from 'express';
import { adminMembershipAllows, type AdminAction } from '../security/admin-authorization';
import { lookupAdminMembership } from '../security/admin-security-service';

export function requireAdminAction(action: AdminAction) {
  return async function tenantAdminMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const tenantId = req.tenantId;
    const subject = req.user?.sub;
    if (!tenantId || !subject) {
      res.status(401).json({ error: 'Unauthorized: Missing administrator identity' });
      return;
    }
    try {
      const membership = await lookupAdminMembership(tenantId, subject);
      if (!adminMembershipAllows(membership, { tenantId, subject, action })) {
        res.status(403).json({ error: 'Forbidden: Tenant administrator permission is required' });
        return;
      }
      req.adminRole = membership?.role;
      next();
    } catch {
      res.status(503).json({ error: 'Administrator authorization is temporarily unavailable' });
    }
  };
}
