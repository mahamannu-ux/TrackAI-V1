/**
 * IT-T19i-01 local sign-in stub: a JWKS/JWT stand-in for Supabase Auth, for the four
 * walkthrough users (task19i-walkthrough-users.ts), so the real web app signs in through
 * its real Supabase client and the real API verifies the real RS256 tokens.
 *
 * Ported from TrackAI Task5 acceptance auth, `apps/api/src/features/evidence/task5-acceptance-auth.ts`
 * at `main` 0d4099c. Deviations: the users come from the shared walkthrough list; the port
 * and the allowed web origin come from the environment (the walkthrough picks free ports);
 * it prints no e-mail addresses. Its guard is kept and widened: it refuses production and any
 * database that is not a local ephemeral one.
 *
 *   TASK19I_AUTH_PORT=<port> TASK19I_WEB_ORIGIN=http://127.0.0.1:<web port> \
 *     npx tsx src/features/qa/testing/task19i-walkthrough-auth.ts
 */
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { WALKTHROUGH_USERS, assertEphemeralDatabase, type WalkthroughUser } from './task19i-walkthrough-users';

assertEphemeralDatabase('The Task19i walkthrough sign-in stub');

const port = Number(process.env.TASK19I_AUTH_PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error('TASK19I_AUTH_PORT is required');
const origins = (process.env.TASK19I_WEB_ORIGIN ?? '').split(',').filter(Boolean);
const users: WalkthroughUser[] = Object.values(WALKTHROUGH_USERS);
const issuer = `http://127.0.0.1:${port}/auth/v1`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = randomUUID();
const publicJwk = publicKey.export({ format: 'jwk' });
const refreshTokens = new Map<string, WalkthroughUser>();

function stubUser(user: WalkthroughUser) {
  const timestamp = new Date().toISOString();
  return {
    id: user.subject,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: timestamp,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function issueSession(user: WalkthroughUser) {
  const expiresIn = 60 * 60;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  const accessToken = jwt.sign({
    sub: user.subject,
    email: user.email,
    aud: 'authenticated',
    role: 'authenticated',
    iss: issuer,
  }, privateKey, { algorithm: 'RS256', keyid: kid, expiresIn });
  const refreshToken = randomUUID();
  refreshTokens.set(refreshToken, user);
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: expiresAt,
    refresh_token: refreshToken,
    user: stubUser(user),
  };
}

const app = express();
app.use(cors({ origin: origins }));
app.use(express.json());

app.get('/auth/v1/.well-known/jwks.json', (_req, res) => {
  res.json({ keys: [{ ...publicJwk, kid, use: 'sig', alg: 'RS256' }] });
});

app.post('/auth/v1/token', (req, res) => {
  const grantType = String(req.query.grant_type ?? '');
  const passwordUser = grantType === 'password'
    ? users.find(user => req.body?.email === user.email && req.body?.password === user.password)
    : undefined;
  const refreshUser = grantType === 'refresh_token' && typeof req.body?.refresh_token === 'string'
    ? refreshTokens.get(req.body.refresh_token)
    : undefined;
  const user = passwordUser ?? refreshUser;
  if (!user) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid walkthrough credentials' });
    return;
  }
  res.json(issueSession(user));
});

app.get('/auth/v1/user', (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }
  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'], audience: 'authenticated',
    }) as jwt.JwtPayload;
    const user = users.find(candidate => candidate.subject === decoded.sub);
    if (!user) throw new Error('unknown_walkthrough_user');
    res.json(stubUser(user));
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
});

app.post('/auth/v1/logout', (_req, res) => res.status(204).end());
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(port, '127.0.0.1', () => {
  console.log(`task19i_walkthrough_auth=ready port=${port} users=${users.length}`);
});
