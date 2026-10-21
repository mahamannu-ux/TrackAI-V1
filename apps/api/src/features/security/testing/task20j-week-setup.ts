/** Synthetic two-tenant setup and auth for the kept, local Task20j database only. */
import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { db, pool } from '../../../core/db';
import { scmRepositories, ssoTenants, tenantAdminMemberships } from '../../../core/db/schema';
import { issueMachineCredential, registerDeveloperMachine } from '../../../core/security/machine-security-service';
import { trustFixture } from './trust-fixture';

type User = { email: string; subject: string; password: string };
type AuthConfig = { users: User[]; kid: string };

function requireLocalDatabase(): void {
  if (process.env.NODE_ENV === 'production' || process.env.TASK20J_WEEK_DATABASE !== '1') {
    throw new Error('Task20j setup requires the dedicated local week database flag');
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.pathname !== '/trackai_task20h_founder') {
    throw new Error('Task20j setup requires the local trackai_task20h_founder database');
  }
}

function save(directory: string, name: string, value: string): void {
  writeFileSync(join(directory, name), value, { flag: 'wx', mode: 0o600 });
}

async function seed(directory: string): Promise<void> {
  requireLocalDatabase();
  if (existsSync(directory)) throw new Error('output directory already exists; use a fresh path');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, 'trust'), { mode: 0o700 });
  mkdirSync(join(directory, 'private'), { mode: 0o700 });
  const fixture = trustFixture(new Date());
  const users: User[] = [];
  const aliases: Record<string, { tenantId: string; repositoryId: string }> = {};
  try {
    for (const company of ['a', 'b'] as const) {
      const domain = `task20j-${company}.acceptance.invalid`;
      const [tenant] = await db.insert(ssoTenants).values({
        companyName: `Task20j Company ${company.toUpperCase()}`,
        domain,
        supabaseProviderId: `task20j-${company}-${randomUUID()}`,
      }).returning({ id: ssoTenants.id });
      const [repository] = await db.insert(scmRepositories).values({
        tenantId: tenant.id,
        provider: 'github',
        externalId: `task20j-${company}-${randomUUID()}`,
        name: `Task20j ${company.toUpperCase()} synthetic repository`,
        url: `https://example.invalid/task20j-${company}`,
        normalizedUrl: `https://example.invalid/task20j-${company}`,
      }).returning({ id: scmRepositories.id });
      aliases[company] = { tenantId: tenant.id, repositoryId: repository.id };
      for (const role of ['admin', 'auditor'] as const) {
        const subject = `task20j-${company}-${role}-${randomUUID()}`;
        const email = `${role}@${domain}`;
        await db.insert(tenantAdminMemberships).values({
          tenantId: tenant.id,
          subject,
          email,
          role: role === 'admin' ? 'tenant_admin' : 'tenant_auditor',
          status: 'active',
          grantedBy: 'task20j-week-setup',
        });
        users.push({ email, subject, password: randomBytes(18).toString('base64url') });
      }
    }
    const machine = await registerDeveloperMachine({
      tenantId: aliases.a.tenantId,
      installationId: `task20j-${randomUUID()}`,
      displayName: 'Task20j Intel Mac',
      platform: 'macos',
      actorId: users[0].subject,
    });
    const credential = await issueMachineCredential({
      tenantId: aliases.a.tenantId,
      machineId: machine.id,
      actorId: users[0].subject,
    });
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = randomUUID();
    save(directory, 'trust/root.json', `${JSON.stringify(fixture.rootDocument)}\n`);
    save(directory, 'trust/dev-pins.json', `${JSON.stringify([fixture.root.keyid])}\n`);
    save(directory, 'private/policy.pem', fixture.policy.privateKeyPem);
    save(directory, 'private/lease.pem', fixture.lease.privateKeyPem);
    save(directory, 'private/auth-private.pem', privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    save(directory, 'auth-public.pem', publicKey.export({ format: 'pem', type: 'spki' }).toString());
    save(directory, 'private/auth.json', `${JSON.stringify({ users, kid } satisfies AuthConfig)}\n`);
    save(directory, 'private/credential.txt', `${credential.plaintext}\n`);
    save(directory, 'private/bootstrap.json', `${JSON.stringify({
      version: 1,
      repositories: [{
        repository_url: 'https://example.invalid/task20j-a',
        repository_id: aliases.a.repositoryId,
        tenant_id: aliases.a.tenantId,
        api_base_url: 'http://127.0.0.1:8080',
        credential_key_id: credential.keyId,
      }],
    })}\n`);
    save(directory, 'aliases.json', `${JSON.stringify({ ...aliases, machineId: machine.id })}\n`);
    console.log('task20j_week_seed=ready (two tenants, four roles, one Company A machine)');
    console.log('Private credentials and development keys were saved with owner-only permissions; values were not printed.');
  } finally {
    await pool.end();
  }
}

function auth(directory: string): void {
  requireLocalDatabase();
  const config = JSON.parse(readFileSync(join(directory, 'private/auth.json'), 'utf8')) as AuthConfig;
  const privateKey = readFileSync(join(directory, 'private/auth-private.pem'), 'utf8');
  const publicKey = readFileSync(join(directory, 'auth-public.pem'), 'utf8');
  const port = 54321;
  const issuer = `http://127.0.0.1:${port}/auth/v1`;
  const refreshTokens = new Map<string, User>();
  const app = express();
  app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }));
  app.use(express.json());
  const publicJwk = createPublicKey(publicKey).export({ format: 'jwk' });
  const view = (user: User) => ({
    id: user.subject,
    email: user.email,
    aud: 'authenticated',
    role: 'authenticated',
    email_confirmed_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const session = (user: User) => {
    const refreshToken = randomUUID();
    refreshTokens.set(refreshToken, user);
    return {
      access_token: jwt.sign({ sub: user.subject, email: user.email, aud: 'authenticated', role: 'authenticated', iss: issuer }, privateKey,
        { algorithm: 'RS256', keyid: config.kid, expiresIn: '1h' }),
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refreshToken,
      user: view(user),
    };
  };
  app.get('/auth/v1/.well-known/jwks.json', (_req, res) => res.json({ keys: [{ ...publicJwk, kid: config.kid, use: 'sig', alg: 'RS256' }] }));
  app.post('/auth/v1/token', (req, res) => {
    const kind = String(req.query.grant_type ?? '');
    const user = kind === 'password'
      ? config.users.find(candidate => candidate.email === req.body?.email && candidate.password === req.body?.password)
      : kind === 'refresh_token' ? refreshTokens.get(req.body?.refresh_token) : undefined;
    if (!user) return res.status(400).json({ error: 'invalid_grant' });
    return res.json(session(user));
  });
  app.get('/auth/v1/user', (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'missing_token' });
    try {
      const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'], audience: 'authenticated' }) as jwt.JwtPayload;
      const user = config.users.find(candidate => candidate.subject === decoded.sub);
      if (!user) throw new Error('unknown_user');
      return res.json(view(user));
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
  });
  app.post('/auth/v1/logout', (_req, res) => res.status(204).end());
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.listen(port, '127.0.0.1', () => console.log('task20j_week_auth=ready'));
}

const mode = process.argv[2];
const directory = process.argv[3] ? resolve(process.argv[3]) : '';
if (!directory || !['seed', 'auth'].includes(mode)) {
  throw new Error('usage: task20j-week-setup.ts seed|auth <private-directory>');
}
if (mode === 'seed') {
  seed(directory).catch(error => { console.error(`task20j_week_seed_failed=${(error as Error).message}`); process.exitCode = 1; });
} else {
  auth(directory);
}
