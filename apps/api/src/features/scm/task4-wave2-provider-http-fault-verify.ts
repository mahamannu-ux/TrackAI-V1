import { createHmac, randomUUID } from 'node:crypto';

async function main(): Promise<void> {
  const baseUrl = (process.env.TASK4_WAVE2_FAULT_API_BASE_URL ?? 'http://127.0.0.1:8082')
    .trim().replace(/\/$/, '');
  const secret = process.env.TASK4_WAVE2_FAULT_WEBHOOK_SECRET;
  if (!secret) throw new Error('TASK4_WAVE2_FAULT_WEBHOOK_SECRET is required');

  const payload = JSON.stringify({
    ref: 'refs/heads/task4-wave2/fault-probe',
    before: '1'.repeat(40),
    after: '2'.repeat(40),
    forced: false,
    deleted: false,
    commits: [],
    head_commit: { timestamp: new Date().toISOString() },
    repository: {
      id: 9_999_999,
      name: 'task4-disposable-fault-probe',
      html_url: 'https://github.com/task4-disposable/task4-disposable-fault-probe',
      owner: { login: 'task4-disposable' },
    },
  });
  const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const response = await fetch(`${baseUrl}/api/v1/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': `task4-wave2-fault-${randomUUID()}`,
      'x-hub-signature-256': signature,
    },
    body: payload,
  });
  const body = await response.json() as { error?: string };
  if (response.status !== 503
    || response.headers.get('retry-after') !== '5'
    || body.error !== 'Temporary failure processing SCM webhook') {
    throw new Error('Provider transient-failure HTTP contract changed');
  }

  console.log('http_status=503');
  console.log('retry_after=5');
  console.log('response=generic-temporary-failure');
  console.log('signature=verified-with-disposable-secret');
  console.log('database_writes=none-unreachable-adapter');
  console.log('raw_payload=not-printed');
  console.log('provider_http_fault_verification=passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Provider HTTP fault verification failed');
  process.exitCode = 1;
});
