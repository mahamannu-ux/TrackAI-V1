import type { NextFunction, Request, Response } from 'express';
import { adminMembershipAllows, type AdminAction } from '../security/admin-authorization';
import { lookupAdminMembership } from '../security/admin-security-service';

/**
 * The action a guard checks, attached to the guard itself (Task16b): read-only and
 * non-enumerable, so the auditor sweep can assert *which* action guards a route.
 */
const ADMIN_ACTION = Symbol('trackai.requireAdminAction.action');

/** The action of a requireAdminAction guard (or a wrapper that copied it), else undefined. */
export function adminActionOf(handler: unknown): AdminAction | undefined {
  if (typeof handler !== 'function') return undefined;
  return (handler as unknown as Record<symbol, AdminAction | undefined>)[ADMIN_ACTION];
}

function markAdminAction<T extends object>(handler: T, action: AdminAction): T {
  Object.defineProperty(handler, ADMIN_ACTION, { value: action, enumerable: false, writable: false, configurable: false });
  return handler;
}

/**
 * Copies a guard's action onto a wrapper of that guard (problemizeAuth). Copy only:
 * a handler can never be labelled with an action its wrapped guard does not check.
 */
export function copyAdminAction<T extends object>(from: unknown, to: T): T {
  const action = adminActionOf(from);
  return action === undefined ? to : markAdminAction(to, action);
}

export function requireAdminAction(action: AdminAction) {
  return markAdminAction(async function tenantAdminMiddleware(
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
  }, action);
}
