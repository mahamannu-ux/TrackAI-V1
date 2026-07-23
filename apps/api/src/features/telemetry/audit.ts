export type FieldCorrection = {
  targetType: string;
  targetKey: string;
  fieldName: string;
  correctedValue: unknown;
  reason: string;
  evidenceRef: string | null;
};

export function applyAuditedValue<T>(correction: FieldCorrection | undefined, observedValue: T) {
  return {
    observedValue,
    auditedValue: correction ? correction.correctedValue as T : observedValue,
    corrected: Boolean(correction),
    correctionReason: correction?.reason ?? null,
    evidenceRef: correction?.evidenceRef ?? null,
  };
}
