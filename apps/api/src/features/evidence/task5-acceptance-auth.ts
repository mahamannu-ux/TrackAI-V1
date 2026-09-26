import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

if (process.env.NODE_ENV === 'production' || process.env.TASK5_EPHEMERAL_DATABASE !== '1') {
  throw new Error('Task5 acceptance auth may run only outside production with an ephemeral database');
}

const port = Number(process.env.TASK5_ACCEPTANCE_AUTH_PORT ?? 54321);
const users = [
  {
    email: 'admin@task5.acceptance.invalid',
    password: 'task5-acceptance-only',
    subject: 'task5-acceptance-admin',
  },
  {
    email: 'developer@task5.acceptance.invalid',
    password: 'task5-viewer-only',
    subject: 'task5-acceptance-viewer',
  },
] as const;
type AcceptanceUser = typeof users[number];
const issuer = `http://127.0.0.1:${port}/auth/v1`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = randomUUID();
const publicJwk = publicKey.export({ format: 'jwk' });
const refreshTokens = new Map<string, AcceptanceUser>();

function acceptanceUser(user: AcceptanceUser) {
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

function issueSession(user: AcceptanceUser) {
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
    user: acceptanceUser(user),
  };
}

const app = express();
app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }));
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
    res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid acceptance credentials' });
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
    if (!user) throw new Error('unknown_acceptance_user');
    res.json(acceptanceUser(user));
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
});

app.post('/auth/v1/logout', (_req, res) => res.status(204).end());
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(port, '127.0.0.1', () => {
  console.log('task5_acceptance_auth=ready');
  console.log(`acceptance_email=${users[0].email}`);
  console.log(`acceptance_viewer_email=${users[1].email}`);
  console.log(`acceptance_url=http://127.0.0.1:${port}`);
});
