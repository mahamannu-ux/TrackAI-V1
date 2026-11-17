import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminSecurityFindingRow } from './admin-security-finding-row';

test('admin finding renders missing repository and phase', () => {
  const html = renderToStaticMarkup(<table><tbody><AdminSecurityFindingRow
    finding={{
      id: 'synthetic', machineId: 'synthetic-machine', repositoryId: null,
      findingId: 'synthetic-finding', ruleId: 'secrets.agent_read_env', ruleVersion: '1.3',
      ruleSeverity: 'medium', effect: 'monitor', phase: null, operatingSystem: 'macos',
      occurredAt: '2026-11-17T00:00:00Z', receivedAt: '2026-11-17T00:00:01Z',
    }} repositoryName={null}
  /></tbody></table>);
  assert.match(html, /Not in an enrolled repository/);
  assert.match(html, /Phase not reported/);
  assert.match(html, /secrets\.agent read env/);
});
