// Ported from SushiCorp AU-1 route-table sweep
// (tests/unit/api/test_api_auditor.py @ 0bd67a5): the auditor rule is generated
// from the route table, so a new admin route fails this test until it is listed
// below with the action its requireAdminAction guard uses (read from the route
// file). This test never touches the database: it walks the Express router
// stacks in-process and evaluates adminMembershipAllows purely in memory
// (building the fleet and attesta routers with default dependencies needs no
// database; verified by running this file with no DATABASE_URL set).

import assert from 'node:assert/strict';
import type { Router } from 'express';
import test from 'node:test';
import { ADMIN_ACTIONS, adminMembershipAllows, type AdminAction } from './admin-authorization';
import type { AdminMembershipRecord } from './admin-authorization';
import adminRouter from '../../features/admin/admin.routes';
import { evidenceAdminRouter } from '../../features/evidence/evidence.routes';
import { createFleetAdminRouter } from '../../features/fleet/fleet.routes';
import { createAttestaRouter } from '../../features/attesta/attesta.routes';

// Mount points from apps/api/src/app.ts (adminRouter at /api/admin,
// evidenceAdminRouter at /api/admin/evidence, fleetAdminRouter at
// /api/admin/fleet, attestaRouter at /api/attesta). Keys below use the full
// path so the routers can never collide.
const ADMIN_MOUNT = '/api/admin';
const EVIDENCE_ADMIN_MOUNT = '/api/admin/evidence';
const FLEET_ADMIN_MOUNT = '/api/admin/fleet';
const ATTESTA_MOUNT = '/api/attesta';

// Every guarded route on the admin, evidence-admin and fleet routers, mapped to
// the action its requireAdminAction guard passes (read from the route file, not
// recoverable at runtime because requireAdminAction closes over the action).
// The fleet router carries one router-level guard
// (requireAdminAction('machine.manage') via router.use, fleet.routes.ts:125-128)
// instead of per-route guards.
const ROUTE_ACTIONS: Record<string, AdminAction> = {
  // --- adminRouter ---
  'GET /api/admin/machines': 'machine.manage',
  'GET /api/admin/repository-policies': 'repository.manage',
  'GET /api/admin/backfill-authorizations': 'backfill.manage',
  'GET /api/admin/audit': 'audit.read',
  'GET /api/admin/security-findings': 'security_findings.read',
  'GET /api/admin/operations/retention-policy': 'operations.read',
  'POST /api/admin/operations/retention-policy': 'retention.manage',
  'GET /api/admin/operations/retention-plan': 'operations.read',
  'GET /api/admin/operations/monitoring': 'operations.read',
  'GET /api/admin/operations/exports': 'operations.read',
  'POST /api/admin/operations/exports/plan': 'export.manage',
  'POST /api/admin/operations/exports': 'export.manage',
  'GET /api/admin/operations/exports/:id/download': 'export.manage',
  'POST /api/admin/machines': 'machine.manage',
  'POST /api/admin/machines/:id/credentials': 'machine.manage',
  'POST /api/admin/machine-credentials/:id/revoke': 'machine.manage',
  'POST /api/admin/machines/:id/revoke': 'machine.manage',
  'POST /api/admin/repository-enrollments': 'repository.manage',
  'POST /api/admin/repository-enrollments/:id/revoke': 'repository.manage',
  'POST /api/admin/repository-grants': 'repository.manage',
  'POST /api/admin/repository-grants/:id/revoke': 'repository.manage',
  'POST /api/admin/repository-grants/:id/branch-scope': 'repository.manage',
  'POST /api/admin/backfill-authorizations': 'backfill.manage',
  'POST /api/admin/backfill-authorizations/:id/revoke': 'backfill.manage',
  'GET /api/admin/github-app/installations': 'github_app.manage',
  'POST /api/admin/github-app/installations': 'github_app.manage',
  'POST /api/admin/github-app/installations/:id/credentials/rotate': 'github_app.manage',
  'POST /api/admin/github-app/installations/:id/credentials/finish': 'github_app.manage',
  'POST /api/admin/github-app/installations/:id/revoke': 'github_app.manage',
  // --- evidenceAdminRouter ---
  'GET /api/admin/evidence/settings': 'evidence.raw.read',
  'PUT /api/admin/evidence/settings': 'evidence.consent.manage',
  'POST /api/admin/evidence/purge-expired': 'evidence.consent.manage',
  'GET /api/admin/evidence/semantic-health': 'evidence.raw.read',
  'POST /api/admin/evidence/semantic-reindex': 'evidence.consent.manage',
  'POST /api/admin/evidence/intentions/:id/corrections': 'evidence.correct',
  // --- fleetAdminRouter (router-level machine.manage guard) ---
  'GET /api/admin/fleet/machines': 'machine.manage',
  'POST /api/admin/fleet/configurations': 'machine.manage',
  'POST /api/admin/fleet/assignments': 'machine.manage',
  'POST /api/admin/fleet/machines/:id/offboard/preview': 'machine.manage',
  'POST /api/admin/fleet/machines/:id/offboard': 'machine.manage',
};

// Non-GET attesta routes mapped to their effective per-route action (read from
// attesta.routes.ts: the whole-router attesta.read guard at :120 plus the
// per-route attesta.export guard at :194). Every one is auditor-reachable by
// design (see AUDITOR_ALLOWED_WRITES); a new attesta mutation fails the sweep
// until it is classified here.
const ATTESTA_WRITE_ACTIONS: Record<string, AdminAction> = {
  'POST /api/attesta/evidence-packs': 'attesta.export',
  'POST /api/attesta/period-reports': 'attesta.export',
};

// Auditor-reachable non-GET routes, with the one-line reason each. Anything
// auditor-reachable outside this map fails the sweep.
const AUDITOR_ALLOWED_WRITES: Record<string, string> = {
  'POST /api/attesta/evidence-packs': 'creates an audited export job; changes no evidence.',
  'POST /api/attesta/period-reports': 'creates an audited export job; changes no evidence.',
};

// GET routes whose guard action stays admin-only, with the one-line reason each.
const ADMIN_ONLY_READS: Record<string, string> = {
  'GET /api/admin/machines': 'developer-machine inventory and credential metadata are operator configuration, not evidence.',
  'GET /api/admin/repository-policies': 'enrollment and grant inventory is operator configuration, not evidence.',
  'GET /api/admin/backfill-authorizations': 'backfill authorization windows are operator configuration, not evidence.',
  'GET /api/admin/github-app/installations': 'installation records carry credential metadata and fingerprints for operators.',
  'GET /api/admin/operations/exports/:id/download': 'streams the full operator archive bytes; auditors use the signed export (A16.7) instead.',
  'GET /api/admin/fleet/machines': 'fleet machine inventory and rollout state are operator configuration, not evidence.',
};

// Routes on the swept routers with no requireAdminAction guard at all.
const UNGUARDED_ROUTES: Record<string, string> = {
  'GET /api/admin/context': 'reports only the caller\u2019s own identity and membership; no tenant data beyond the caller\u2019s subject.',
};

const AUDITOR_MEMBERSHIP: AdminMembershipRecord = {
  tenantId: 'tenant-a',
  subject: 'auditor-1',
  role: 'tenant_auditor',
  status: 'active',
  revokedAt: null,
};

interface StackedRoute {
  method: string;
  key: string;
  layers: number;
}

interface StackedRouter {
  mount: string;
  router: Router;
  /** 'per-route': one guard per route; 'router-level': one guard for the whole router. */
  guard: 'per-route' | 'router-level';
  /** Router-level guard only: exact middleware layers before the first route
    (fleet.routes.ts:128; attesta.routes.ts:119-120). This pins the guard's
    presence and position, not which action it checks (unreadable at runtime). */
  leadingLayers?: number;
}

function routesOf(router: Router, mount: string): StackedRoute[] {
  const stack = (router as unknown as { stack: Array<{
    route?: { path: unknown; methods: Record<string, boolean>; stack: unknown[] };
  }> }).stack;
  const out: StackedRoute[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    assert.equal(
      typeof layer.route.path,
      'string',
      `admin route path must be a string for the sweep (got ${String(layer.route.path)})`,
    );
    // Express serves HEAD from GET handlers; it is not a separate auditor surface.
    const methods = Object.keys(layer.route.methods)
      .filter(method => method !== '_all' && method !== 'head')
      .map(method => method.toUpperCase());
    for (const method of methods) {
      out.push({ method, key: `${method} ${mount}${layer.route.path as string}`, layers: layer.route.stack.length });
    }
  }
  return out;
}

/** Non-route (middleware) layers before the first route layer: the router-level guard. */
function leadingMiddleware(router: Router): number {
  const stack = (router as unknown as { stack: Array<{ route?: unknown }> }).stack;
  let count = 0;
  for (const layer of stack) {
    if (layer.route) break;
    count += 1;
  }
  return count;
}

const SWEPT: StackedRouter[] = [
  { mount: ADMIN_MOUNT, router: adminRouter, guard: 'per-route' },
  { mount: EVIDENCE_ADMIN_MOUNT, router: evidenceAdminRouter, guard: 'per-route' },
  { mount: FLEET_ADMIN_MOUNT, router: createFleetAdminRouter(), guard: 'router-level', leadingLayers: 1 },
  { mount: ATTESTA_MOUNT, router: createAttestaRouter(), guard: 'router-level', leadingLayers: 2 },
];

const STACKED: StackedRoute[] = SWEPT.flatMap(entry => routesOf(entry.router, entry.mount));

// Actions the auditor is allowed, computed from the same decision function the
// middleware uses (today: audit.read, security_findings.read, operations.read,
// evidence.raw.read, attesta.read, attesta.export).
const AUDITOR_ACTIONS = new Set(
  ADMIN_ACTIONS.filter(action => adminMembershipAllows(AUDITOR_MEMBERSHIP, {
    tenantId: AUDITOR_MEMBERSHIP.tenantId,
    subject: AUDITOR_MEMBERSHIP.subject,
    action,
  })),
);

function onAttesta(key: string): boolean {
  return key.includes(`${ATTESTA_MOUNT}/`);
}

function auditorAllows(action: AdminAction): boolean {
  return adminMembershipAllows(AUDITOR_MEMBERSHIP, {
    tenantId: AUDITOR_MEMBERSHIP.tenantId,
    subject: AUDITOR_MEMBERSHIP.subject,
    action,
  });
}

test('auditor sweep: route tables match the swept routers', () => {
  const stackedKeys = new Set(STACKED.map(route => route.key));
  // Attesta GETs are auditor-readable by design (whole-router attesta.read
  // guard) and intentionally not tabled; only its mutations are pinned.
  const attestaStacked = new Set(
    STACKED.filter(route => onAttesta(route.key)).map(route => route.key),
  );
  const tableKeys = new Set([
    ...Object.keys(ROUTE_ACTIONS),
    ...Object.keys(UNGUARDED_ROUTES),
    ...Object.keys(ATTESTA_WRITE_ACTIONS),
  ]);
  const missing = [...stackedKeys].filter(key => (
    !tableKeys.has(key) && !(key.startsWith('GET /api/attesta/'))
  ));
  const stale = [...tableKeys].filter(key => !stackedKeys.has(key));
  assert.deepEqual(missing, [], `admin routes not in the sweep tables (add them): ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `sweep table entries with no matching route (remove them): ${stale.join(', ')}`);
  const attestaNonGet = [...attestaStacked].filter(key => !key.startsWith('GET ')).sort();
  assert.deepEqual(
    attestaNonGet,
    Object.keys(ATTESTA_WRITE_ACTIONS).sort(),
    'attesta non-GET routes must be exactly the pinned auditor-allowed writes',
  );
});

test('auditor sweep: every swept router carries its guard', () => {
  for (const entry of SWEPT) {
    const routes = routesOf(entry.router, entry.mount);
    if (entry.guard === 'router-level') {
      assert.equal(
        leadingMiddleware(entry.router),
        entry.leadingLayers,
        `${entry.mount} must carry exactly its router-level guard layers before its routes (guard removed or added?)`,
      );
    }
    for (const route of routes) {
      if (UNGUARDED_ROUTES[route.key]) {
        assert.equal(route.layers, 1, `${route.key} is listed unguarded but carries middleware`);
      } else if (entry.guard === 'per-route') {
        assert.ok(
          route.layers >= 2,
          `${route.key} is listed with action ${ROUTE_ACTIONS[route.key]} but has no guard layer`,
        );
      }
      if (ATTESTA_WRITE_ACTIONS[route.key] !== undefined) {
        assert.ok(
          route.layers >= 2,
          // exportAuth plus the handler (attesta.routes.ts:209 and :289); without
          // exportAuth the pinned POST would fall back to the router-level
          // attesta.read guard unnoticed.
          `${route.key} is a pinned auditor-allowed write but carries no per-route export guard layer`,
        );
      }
    }
  }
});

test('auditor sweep: every mutating route is denied to tenant_auditor, except pinned writes', () => {
  const failures: string[] = [];
  for (const route of STACKED) {
    if (route.method === 'GET' || UNGUARDED_ROUTES[route.key]) continue;
    if (AUDITOR_ALLOWED_WRITES[route.key] !== undefined) {
      const action = ATTESTA_WRITE_ACTIONS[route.key];
      assert.ok(
        (ADMIN_ACTIONS as readonly string[]).includes(action),
        `${route.key} maps to unknown action ${String(action)}`,
      );
      assert.ok(
        auditorAllows(action),
        `${route.key} is pinned auditor-allowed but action ${action} denies the auditor (guard changed?)`,
      );
      continue;
    }
    const action = ROUTE_ACTIONS[route.key];
    assert.ok(
      (ADMIN_ACTIONS as readonly string[]).includes(action),
      `${route.key} maps to unknown action ${String(action)}`,
    );
    if (auditorAllows(action)) {
      failures.push(`${route.key} (${action})`);
    }
  }
  assert.deepEqual(failures, [], `mutating routes reachable by tenant_auditor (security finding, do not fix here): ${failures.join(', ')}`);
  for (const key of Object.keys(AUDITOR_ALLOWED_WRITES)) {
    assert.ok(
      STACKED.some(route => route.key === key && route.method !== 'GET'),
      `AUDITOR_ALLOWED_WRITES entry ${key} matches no mutating route (remove it)`,
    );
  }
});

test('auditor sweep: every GET route is auditor-readable or explicitly admin-only', () => {
  for (const route of STACKED) {
    if (route.method !== 'GET' || UNGUARDED_ROUTES[route.key]) continue;
    if (onAttesta(route.key)) continue;
    const action = ROUTE_ACTIONS[route.key];
    if (AUDITOR_ACTIONS.has(action)) continue;
    assert.ok(
      ADMIN_ONLY_READS[route.key] !== undefined,
      `${route.key} uses non-auditor action ${action} but has no ADMIN_ONLY_READS reason (add one or confirm auditor access)`,
    );
  }
  for (const key of Object.keys(ADMIN_ONLY_READS)) {
    assert.ok(
      STACKED.some(route => route.key === key && route.method === 'GET'),
      `ADMIN_ONLY_READS entry ${key} matches no GET route (remove it)`,
    );
  }
});
