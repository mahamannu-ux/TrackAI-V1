/** Task16b (A16.3): the audit contract. Contract and rules: docs/contracts/audit/README.md. */
export {
  AUDIT_ACTOR_TYPES,
  AUDIT_CATALOG,
  AUDIT_CATALOG_VERSION,
  AUDIT_CONTRACT_ERROR_CODES,
  AUDIT_SEVERITIES,
  AuditContractError,
} from './catalog';
export type {
  AuditActorType,
  AuditCatalogEntry,
  AuditContractErrorCode,
  AuditDetailKey,
  AuditDetailShape,
  AuditDetailType,
  AuditEvent,
  AuditRow,
  AuditScalarType,
  AuditSeverity,
  AuditStatus,
  AuditTargetIdKind,
} from './catalog';
export { buildAuditRow, recordAuditEvent, type AuditExecutor } from './record';
