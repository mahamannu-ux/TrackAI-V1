import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// Extend Express Request to include the decoded user payload (Kept exactly as you had it)
declare global {
  namespace Express {
    interface Request {
      user?: jwt.JwtPayload;
    }
  }
}

// Initialize the JWKS client to pull public keys directly from your Supabase instance
const client = jwksClient({
  // Tries to pull from env, defaults to your specific project domain fallback
  jwksUri: `${process.env.SUPABASE_URL || 'https://supabase.co'}/auth/v1/.well-known/jwks.json`,
  cache: true,
  rateLimit: true,
  jwksRequestsPerMinute: 10
});

// Helper function to dynamically retrieve the correct signing key for the token
function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  if (!header.kid) {
    return callback(new Error('Missing kid in JWT header'), undefined);
  }

  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err, undefined);
    } else {
      const signingKey = key?.getPublicKey();
      callback(null, signingKey);
    }
  });
}

/**
 * JWT Authentication Middleware (Updated for Asymmetric RS256)
 */
export function authenticateJWT(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  // Step 1: Check if the Authorization header exists and has the Bearer scheme
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  // Step 2: Extract the raw JWT token
  const token = authHeader.split(' ')[1];

  // Replace the old jwt.verify block inside your auth.ts with this:
  jwt.verify(token, getKey, (err, decoded) => {
    if (err) {
      console.error('JWT verification failed:', err.message);
      res.status(401).json({ error: 'Invalid or expired token', details: err.message });
      return;
    }

    req.user = decoded as jwt.JwtPayload;
    next();
  });

}
