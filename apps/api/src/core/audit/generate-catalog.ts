/**
 * Generates docs/contracts/audit/catalog.md from AUDIT_CATALOG (the CF-1 "generated
 * and test-checked" pattern: audit-contract.test.ts fails when the file is stale).
 *
 *   npm run audit:catalog -w apps/api
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUDIT_CATALOG,
  AUDIT_CATALOG_VERSION,
  type AuditCatalogEntry,
  type AuditDetailKey,
  type AuditDetailShape,
  type AuditDetailType,
} from './catalog';

export const CATALOG_MD_PATH = resolve(__dirname, '../../../../../docs/contracts/audit/catalog.md');

function typeText(type: AuditDetailType): string {
  if (typeof type === 'string') return type;
  if ('enum' in type) return `enum[${type.enum.join(', ')}]`;
  if ('object' in type) return `{ ${shapeText(type.object)} }`;
  return `[{ ${shapeText(type.arrayOf)} }]`;
}

function keyText(name: string, key: AuditDetailKey): string {
  return `${name}${key.required ? '' : '?'}: ${typeText(key.type)}${key.nullable ? ' \\| null' : ''}`;
}

function shapeText(shape: AuditDetailShape): string {
  return Object.entries(shape).map(([name, key]) => keyText(name, key)).join(', ');
}

function targetIdText(entry: AuditCatalogEntry): string {
  if (entry.targetIdKind === 'tenant') return 'tenant (the tenant id)';
  if (entry.targetIdPattern) {
    return `${entry.targetIdKind}: ${entry.targetIdNote ?? ''} \`${entry.targetIdPattern.source}\``.replace(/\|/g, '\\|');
  }
  return 'row (uuid)';
}

function row(entry: AuditCatalogEntry): string {
  const details = Object.entries(entry.details).map(([name, key]) => `\`${keyText(name, key)}\``).join('<br>');
  return [
    `\`${entry.action}\``,
    entry.owner,
    entry.severity,
    entry.actorTypes.join(', '),
    `\`${entry.targetType}\``,
    targetIdText(entry),
    details || '(none)',
    entry.status,
  ].join(' | ');
}

export function renderAuditCatalog(): string {
  const emitted = AUDIT_CATALOG.filter(entry => entry.status === 'emitted');
  const reserved = AUDIT_CATALOG.filter(entry => entry.status === 'reserved');
  const count = (severity: string) => emitted.filter(entry => entry.severity === severity).length;
  const header = '| Action | Owner | Severity | Actor types | Target type | Target id | Details keys (`?` optional) | Status |\n'
    + '|---|---|---|---|---|---|---|---|';
  return [
    '# Audit event catalog (generated)',
    '',
    '<!-- Generated from apps/api/src/core/audit/catalog.ts by `npm run audit:catalog -w apps/api`. Do not edit by hand: a unit test fails when this file is out of date. -->',
    '',
    `Catalog version ${AUDIT_CATALOG_VERSION}. ${emitted.length} emitted actions (${count('high')} high, ${count('notice')} notice, ${count('info')} info) and ${reserved.length} reserved.`,
    'Rules: `README.md` in this folder. Every action also accepts an optional `request_id: string` (AP-1).',
    'Types: `string` at most 512 characters, `reason` at most 1000, `string[]`/`uuid[]` at most 200 items, `counts` an object of non-negative integers, `string_map` an object of strings, `sha256_digest` is `sha256:<64 hex>`.',
    '',
    '## Emitted',
    '',
    header,
    ...emitted.map(entry => `| ${row(entry)} |`),
    '',
    '## Reserved (refused until the owning Task flips them to emitted)',
    '',
    header,
    ...reserved.map(entry => `| ${row(entry)} |`),
    '',
  ].join('\n');
}

if (require.main === module) {
  writeFileSync(CATALOG_MD_PATH, renderAuditCatalog());
  console.log(`audit catalog written (version ${AUDIT_CATALOG_VERSION}, ${AUDIT_CATALOG.length} actions)`);
}
