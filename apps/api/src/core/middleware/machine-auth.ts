import { createHash, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { ssoTenants } from '../db/schema';

type TokenTenantMap = Record<string, string>;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function parseIngestTokenMap(raw = process.env.TRACKAI_INGEST_TOKENS_JSON): TokenTenantMap {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TRACKAI_INGEST_TOKENS_JSON must be a JSON object');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([token, tenantId]) => !token || typeof tenantId !== 'string' || !tenantId)) {
    throw new Error('Every ingestion token must map to a tenant UUID string');
  }
  return Object.fromEntries(entries) as TokenTenantMap;
}

export function resolveTenantForToken(token: string, tokenMap: TokenTenantMap): string | null {
  const suppliedDigest = digest(token);
  for (const [candidate, tenantId] of Object.entries(tokenMap)) {
    if (timingSafeEqual(suppliedDigest, digest(candidate))) return tenantId;
  }
  return null;
}

/** Machine authentication for Git AI's X-API-Key upload contract. */
export async function authenticateMachine(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const apiKey = req.get('x-api-key');
  if (!apiKey) {
    res.status(401).json({ error: 'Missing X-API-Key' });
    return;
  }

  let tenantId: string | null;
  try {
    tenantId = resolveTenantForToken(apiKey, parseIngestTokenMap());
  } catch (error) {
    console.error('Invalid ingestion token configuration');
    res.status(503).json({ error: 'Ingestion authentication is unavailable' });
    return;
  }

  if (!tenantId) {
    res.status(401).json({ error: 'Invalid X-API-Key' });
    return;
  }

  try {
    const [tenant] = await db
      .select({ id: ssoTenants.id })
      .from(ssoTenants)
      .where(eq(ssoTenants.id, tenantId))
      .limit(1);
    if (!tenant) {
      res.status(401).json({ error: 'Ingestion tenant is not registered' });
      return;
    }
    req.tenantId = tenant.id;
    req.machineId = req.get('x-trackai-machine-id') ?? undefined;
    next();
  } catch (error) {
    console.error('Failed to resolve ingestion tenant');
    res.status(503).json({ error: 'Ingestion authentication is unavailable' });
  }
}
