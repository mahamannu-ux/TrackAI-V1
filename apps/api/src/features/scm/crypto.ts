import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies GitHub's X-Hub-Signature-256 value against the exact request body.
 */
export function verifyGitHubSignature(
  signature: string,
  rawBody: string,
  secret: string,
): boolean {
  if (!signature.startsWith('sha256=') || !secret) return false;

  const digest = createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  const expectedSignature = Buffer.from(`sha256=${digest}`, 'utf8');
  const receivedSignature = Buffer.from(signature, 'utf8');

  return expectedSignature.length === receivedSignature.length
    && timingSafeEqual(expectedSignature, receivedSignature);
}
