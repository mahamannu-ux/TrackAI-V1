/**
 * Publish security settings from the command line (Task20f; AGENTS.md §9 item 10: dry run
 * first, exact scope stated):
 *
 *   npm run security:settings -w apps/api -- --tenant <uuid> --operator <name> --change <file.json>            # plan only
 *   npm run security:settings -w apps/api -- --tenant <uuid> --operator <name> --change <file.json> --confirm  # publish
 *
 * <file.json> is the admin API's PUT body without `dry_run`: `{reason, monitor_mode?,
 * rules?, data_settings?, agents?, day_one_scan?}`. Without --confirm it prints the changed
 * rules, the new versions and the active-machine count, and writes nothing. Signing uses
 * the environment's policy_bundle key (signing-env.ts); no key → nothing is published.
 * Output names rules and counts only, never a key or a credential.
 */
import { readFileSync } from 'node:fs';
import { applySecuritySettings, parseSettingsChange, planSecuritySettings } from './service';
import { securitySignerFromEnv } from './signing-env';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  const tenantId = arg(argv, '--tenant');
  const operator = arg(argv, '--operator');
  const changeFile = arg(argv, '--change');
  if (!tenantId || !UUID_RE.test(tenantId) || !operator || !/^[A-Za-z0-9._@-]{1,64}$/.test(operator) || !changeFile) {
    out('usage: security:settings --tenant <uuid> --operator <name> --change <file.json> [--confirm]');
    return 2;
  }
  const body = JSON.parse(readFileSync(changeFile, 'utf8')) as Record<string, unknown>;
  const { change } = parseSettingsChange({ ...body, dry_run: !argv.includes('--confirm') });
  const plan = await planSecuritySettings(tenantId, change);
  out(`tenant ${tenantId}: ${plan.ruleChanges.length} rule change(s), data settings ${plan.leaseChanged ? 'changed' : 'unchanged'}, monitor ${plan.current.monitor.mode} -> ${plan.monitorMode}`);
  for (const rule of plan.ruleChanges) {
    out(`  ${rule.id}: ${rule.from.enabled ? 'on' : 'off'}/${rule.from.severity} -> ${rule.to.enabled ? 'on' : 'off'}/${rule.to.severity}`);
  }
  out(`  publishes bundle: ${plan.publishesBundle ? `yes (version ${plan.next.bundleVersion}, epoch ${plan.next.epoch})` : 'no'}`);
  out(`  active machines affected: ${plan.activeMachineCount}`);
  if (plan.exceedsSignerLimit) out('  REFUSED on apply: the compiled bundle exceeds the 1 MiB signer cap; override fewer rules.');
  if (!argv.includes('--confirm')) {
    out('dry run: nothing written. Re-run with --confirm to publish.');
    return 0;
  }
  const applied = await applySecuritySettings({ tenantId, actor: { type: 'system_operator', id: operator }, change },
    { signer: securitySignerFromEnv('policy_bundle') });
  out(applied.changed
    ? `published: rule settings v${applied.ruleSettingsVersion}, data settings v${applied.dataSettingsVersion}, monitor v${applied.monitorVersion}${applied.bundle ? `, bundle v${applied.bundle.bundleVersion} epoch ${applied.bundle.epoch} ${applied.bundle.digest}` : ''}`
    : 'nothing changed; nothing written.');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    (err: unknown) => {
      // Task20f's own errors name variables and rule ids only; anything else prints its class name.
      const known = ['SecuritySettingsError', 'SecuritySettingsConflict', 'SecuritySigningUnavailable', 'SecurityDocumentTooLarge', 'CompilerError'];
      const name = (err as Error)?.name ?? 'Error';
      console.error(`security:settings failed: ${name}${known.includes(name) ? `: ${(err as Error).message}` : ''}`);
      process.exit(1);
    },
  );
}
