'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiProblemError,
  getSecurityCoverage,
  getSecuritySettings,
  putSecuritySettings,
  type Repository,
  type SecurityCoverageRow,
  type SecuritySettingsChange,
  type SecuritySettingsPlan,
  type SecuritySettingsView,
} from '@/lib/api';
import { FindingsTab } from './security-findings';

type SecurityTab = 'findings' | 'coverage' | 'settings';
type Role = 'tenant_admin' | 'tenant_auditor';
type Problem = { message: string; requestId: string | null };
type RuleDraft = { enabled: boolean; severity: string };
type DataSettingKey = 'command_previews' | 'file_paths' | 'urls' | 'host_identity' | 'user_identity';
type SettingsDraft = {
  rules: Record<string, RuleDraft>;
  dataSettings: SecuritySettingsView['data_settings'];
  monitorMode: 'off' | 'monitor';
};

const SECURITY_PROBLEM_MESSAGES: Record<string, string> = {
  SECURITY_READ_INVALID_QUERY: 'Review the findings filters; one or more values are invalid.',
  SECURITY_READ_FORBIDDEN: 'Your account does not have access to security data.',
  SECURITY_READ_NOT_FOUND: 'This finding is no longer available.',
  SECURITY_READ_UNAVAILABLE: 'Security data is temporarily unavailable.',
  SECURITY_SETTINGS_UNAUTHENTICATED: 'Sign in again to manage security settings.',
  SECURITY_SETTINGS_FORBIDDEN: 'Your account does not have permission to change security settings.',
  SECURITY_SETTINGS_INVALID: 'The settings change is invalid. Review the values and try again.',
  SECURITY_SETTINGS_CONFLICT: 'Someone else changed the settings; reload and review again',
  SECURITY_SETTINGS_TOO_LARGE: 'The settings would create a bundle that is too large to sign.',
  SECURITY_SETTINGS_SIGNING_UNAVAILABLE: 'Signing is unavailable; no settings were applied.',
  SECURITY_SETTINGS_UNAVAILABLE: 'Security settings are temporarily unavailable.',
};

const DATA_SETTING_INFO: Array<{
  key: DataSettingKey;
  label: string;
  warning: string;
}> = [
  {
    key: 'command_previews',
    label: 'Command previews',
    warning: 'Short, redacted previews of commands are stored; they are not shown in this console yet.',
  },
  { key: 'file_paths', label: 'File paths', warning: 'File paths are stored and may reveal project structure.' },
  { key: 'urls', label: 'URLs', warning: 'URLs observed by the Endpoint are stored.' },
  { key: 'host_identity', label: 'Host identity', warning: 'Host identifiers are stored with security records.' },
  { key: 'user_identity', label: 'User identity', warning: 'User identifiers are stored with security records.' },
];

const REFUSAL_MESSAGES: Record<string, string> = {
  SIGNATURE_REJECTED: 'The signature or trusted-key binding was rejected.',
  VERIFICATION_UNAVAILABLE: 'The machine could not check the signature; it stays off.',
  LEASE_EXPIRED: 'The lease had expired when the machine checked it.',
  MACHINE_MISMATCH: 'The lease names a different machine.',
  TENANT_MISMATCH: 'The document names a different tenant.',
  EPOCH_REGRESSION: 'The bundle is older than the last applied bundle.',
  BUNDLE_DIGEST_MISMATCH: 'The bundle digest did not match the lease.',
  RULES_CHECK_FAILED: "The machine's rule check did not pass.",
  UNSUPPORTED_SCHEMA: 'The machine does not support this document version.',
};

function describeProblem(cause: unknown, fallback: string): Problem {
  if (cause instanceof ApiProblemError) {
    return {
      message: (cause.code && SECURITY_PROBLEM_MESSAGES[cause.code]) || fallback,
      requestId: cause.requestId,
    };
  }
  return { message: cause instanceof Error ? cause.message : fallback, requestId: null };
}

function displayDate(value: string | null | undefined): string {
  if (!value) return 'Not reported';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? 'Not reported'
    : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

function readable(value: string | null | undefined): string {
  if (value === 'unreported') return 'Not reported';
  if (value === 'no_lease') return 'No lease';
  if (value === 'not_acknowledged') return 'Not acknowledged';
  return value ? value.replaceAll('_', ' ').replaceAll('-', ' ') : 'Not reported';
}

function Badge({ children, tone = 'slate' }: {
  children: React.ReactNode;
  tone?: 'slate' | 'green' | 'amber' | 'rose' | 'violet';
}) {
  const styles = {
    slate: 'border-slate-700 bg-slate-800 text-slate-300',
    green: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
    amber: 'border-amber-500/20 bg-amber-500/10 text-amber-200',
    rose: 'border-rose-500/20 bg-rose-500/10 text-rose-200',
    violet: 'border-violet-500/20 bg-violet-500/10 text-violet-200',
  };
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs ${styles[tone]}`}>{children}</span>;
}

function ProblemMessage({ problem }: { problem: Problem | null }) {
  if (!problem) return null;
  return <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
    <p>{problem.message}</p>
    {problem.requestId && <p className="mt-1 text-xs text-rose-200/60">Request ID: {problem.requestId}</p>}
  </div>;
}

function loadingMessage() {
  return <p className="py-10 text-center text-sm text-slate-500">Loading security data…</p>;
}

function InfoCard({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
    <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
    <div className="mt-1 break-words text-sm text-slate-200">{value}</div>
  </div>;
}

function CoverageStatus({ value }: { value: string }) {
  const healthy = value.toLowerCase() === 'healthy';
  return <Badge tone={healthy ? 'green' : 'amber'}>{readable(value)}</Badge>;
}

function coverageLease(row: SecurityCoverageRow): { mode: string; expiry: string; epoch: string } {
  if (row.lease === 'no_lease') return { mode: 'No lease', expiry: 'No lease', epoch: 'No lease' };
  const expired = new Date(row.lease.expires_at).getTime() < Date.now();
  return {
    mode: readable(row.lease.mode),
    expiry: expired ? 'Expired' : displayDate(row.lease.expires_at),
    epoch: row.lease.bundle_epoch === 'unknown' ? 'Not reported' : String(row.lease.bundle_epoch),
  };
}

function refusalMessage(code: string | null): string {
  if (!code) return 'The machine reported a refusal without a code.';
  return REFUSAL_MESSAGES[code] ?? 'The machine reported an unrecognized refusal code.';
}

function CoverageTab() {
  const [rows, setRows] = useState<SecurityCoverageRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const load = useCallback(async (cursor?: string, append = false) => {
    setLoading(true);
    setProblem(null);
    try {
      const page = await getSecurityCoverage(cursor);
      setRows(previous => append ? [...previous, ...page.rows] : page.rows);
      setNextCursor(page.next_cursor);
    } catch (cause) {
      setProblem(describeProblem(cause, 'Coverage could not be loaded.'));
    } finally {
      setLoading(false);
      setAttempted(true);
    }
  }, []);

  useEffect(() => {
    if (!attempted) void load();
  }, [attempted, load]);

  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-slate-400">Endpoint status and acknowledgement data returned for each enrolled machine.</p>
      <button type="button" disabled={loading} onClick={() => void load()} className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-violet-500 disabled:opacity-50">Refresh</button>
    </div>
    <ProblemMessage problem={problem} />
    {loading && rows.length === 0 ? loadingMessage() : <div className="space-y-4">
      {rows.map(row => {
        const lease = coverageLease(row);
        const status = row.status === 'unreported' ? null : row.status;
        const acknowledgement = row.acknowledgement === 'not_acknowledged' ? null : row.acknowledgement;
        const refusal = acknowledgement?.result === 'refused' ? acknowledgement.refusal_code : null;
        const health = [
          ['Hook', status?.hook_status ?? 'Not reported'],
          ['Agent view', status?.agent_effective_view ?? 'Not reported'],
          ['Local record', status?.local_record ?? 'Not reported'],
          ['Forwarder acknowledgement', status?.forwarder_ack ?? 'Not reported'],
        ] as const;
        return <article key={row.machine_id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="font-semibold text-white">{row.machine_id}</h3><p className="mt-1 text-sm text-slate-400">{readable(row.platform)} · Numbat {status?.numbat_version || 'Not reported'}</p></div>
            <Badge tone={status ? 'green' : 'amber'}>{status ? 'Status reported' : 'Not reported'}</Badge>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <InfoCard label="Wired agents" value={status ? (status.wired_agents.length ? status.wired_agents.map(readable).join(', ') : 'Not reported') : 'Not reported'} />
            <InfoCard label="Last status time" value={status ? displayDate(status.observed_at) : 'Not reported'} />
            <InfoCard label="Lease mode" value={lease.mode} />
            <InfoCard label="Lease expiry" value={lease.expiry} />
            <InfoCard label="Bundle epoch" value={lease.epoch} />
            <InfoCard label="Last acknowledgement" value={acknowledgement ? displayDate(acknowledgement.received_at) : 'Not acknowledged'} />
          </div>
          <div className="mt-5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Health layers</h4>
            <div className="mt-2 flex flex-wrap gap-2">{health.map(([label, value]) => <div key={label} className="flex items-center gap-2 rounded-lg border border-slate-800 px-3 py-2 text-xs">
              <span className="text-slate-400">{label}</span><CoverageStatus value={value || 'Not reported'} />
            </div>)}</div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            {acknowledgement?.result === 'applied' && <Badge tone="green">Applied</Badge>}
            {acknowledgement?.result === 'refused' && <p className="text-amber-200">{refusalMessage(refusal)} <span className="text-amber-200/60">({refusal ?? 'code not reported'})</span></p>}
            {!acknowledgement && <span className="text-slate-500">Not acknowledged</span>}
          </div>
        </article>;
      })}
      {!loading && rows.length === 0 && <p className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-sm text-slate-500">No enrolled machines were returned.</p>}
    </div>}
    {nextCursor && <div className="text-center"><button type="button" disabled={loading} onClick={() => void load(nextCursor, true)} className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:border-violet-500 disabled:opacity-50">Load more</button></div>}
  </div>;
}

function toDraft(settings: SecuritySettingsView): SettingsDraft {
  return {
    rules: Object.fromEntries(settings.rules.map(rule => [rule.id, { enabled: rule.enabled, severity: rule.severity }])),
    dataSettings: { ...settings.data_settings },
    monitorMode: settings.monitor.mode,
  };
}

function draftSignature(draft: SettingsDraft): string {
  return JSON.stringify(draft);
}

function buildSettingsChange(
  baseline: SecuritySettingsView,
  draft: SettingsDraft,
  dryRun: boolean,
  reason: string,
): SecuritySettingsChange {
  const originalRules = new Map(baseline.rules.map(rule => [rule.id, rule]));
  const rules: NonNullable<SecuritySettingsChange['rules']> = {};
  for (const [id, setting] of Object.entries(draft.rules)) {
    const original = originalRules.get(id);
    if (original && (setting.enabled !== original.enabled || setting.severity !== original.severity)) {
      rules[id] = { enabled: setting.enabled, severity: setting.severity };
    }
  }
  const dataSettings: NonNullable<SecuritySettingsChange['data_settings']> = {};
  for (const setting of DATA_SETTING_INFO) {
    if (draft.dataSettings[setting.key] !== baseline.data_settings[setting.key]) {
      dataSettings[setting.key] = draft.dataSettings[setting.key];
    }
  }
  return {
    dry_run: dryRun,
    reason,
    ...(Object.keys(rules).length ? { rules } : {}),
    ...(Object.keys(dataSettings).length ? { data_settings: dataSettings } : {}),
    ...(draft.monitorMode !== baseline.monitor.mode ? { monitor_mode: draft.monitorMode } : {}),
  };
}

function SettingsTab({ role }: { role: Role }) {
  const canEdit = role === 'tenant_admin';
  const [settings, setSettings] = useState<SecuritySettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsAttempted, setSettingsAttempted] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [plan, setPlan] = useState<SecuritySettingsPlan | null>(null);
  const [planSignature, setPlanSignature] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setSettingsLoading(true);
    setProblem(null);
    try {
      const value = await getSecuritySettings();
      setSettings(value);
      setDraft(toDraft(value));
      setPlan(null);
      setPlanSignature(null);
    } catch (cause) {
      setProblem(describeProblem(cause, 'Security settings could not be loaded.'));
    } finally {
      setSettingsLoading(false);
      setSettingsAttempted(true);
    }
  }, []);

  useEffect(() => {
    if (!settingsAttempted) void load();
  }, [load, settingsAttempted]);

  const dirty = Boolean(settings && draft && draftSignature(draft) !== draftSignature(toDraft(settings)));

  function updateDraft(update: (current: SettingsDraft) => SettingsDraft) {
    setPlan(null);
    setPlanSignature(null);
    setDraft(current => current ? update(current) : current);
  }

  async function reviewChanges() {
    if (!settings || !draft) return;
    setProblem(null);
    setReviewLoading(true);
    try {
      const response = await putSecuritySettings(buildSettingsChange(settings, draft, true, 'Settings review'));
      if (!('dry_run' in response) || response.dry_run !== true) throw new Error('The settings review returned an unexpected response.');
      setPlan(response);
      setPlanSignature(draftSignature(draft));
    } catch (cause) {
      setProblem(describeProblem(cause, 'The settings review could not be completed.'));
    } finally {
      setReviewLoading(false);
    }
  }

  async function applyChanges() {
    if (!settings || !draft || !plan || planSignature !== draftSignature(draft)) return;
    if (!reason.trim()) {
      setProblem({ message: 'Enter a reason before applying these changes.', requestId: null });
      return;
    }
    setProblem(null);
    setApplyLoading(true);
    try {
      const response = await putSecuritySettings(buildSettingsChange(settings, draft, false, reason.trim()));
      if (!('dry_run' in response) || response.dry_run !== false) throw new Error('The settings update returned an unexpected response.');
      setReason('');
      await load();
    } catch (cause) {
      const described = describeProblem(cause, 'The settings could not be applied.');
      if (cause instanceof ApiProblemError && cause.code === 'SECURITY_SETTINGS_CONFLICT') {
        setPlan(null);
        setPlanSignature(null);
      }
      setProblem(described);
    } finally {
      setApplyLoading(false);
    }
  }

  if (settingsLoading && !settings) return loadingMessage();
  if (!settings || !draft) return <div className="space-y-4">
    <ProblemMessage problem={problem} />
    <button type="button" disabled={settingsLoading} onClick={() => void load()} className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:border-violet-500 disabled:opacity-50">Reload settings</button>
  </div>;

  const activePlanMatches = plan !== null && planSignature === draftSignature(draft);
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-sm text-slate-400">{canEdit ? 'Changes stay in this draft until reviewed and applied.' : 'Settings are shown read-only for auditors.'}</p>
        <div className="mt-2 flex flex-wrap gap-2"><Badge tone="violet">Monitor mode: {readable(draft.monitorMode)}</Badge>
          {settings.bundle ? <Badge>Bundle v{settings.bundle.bundle_version} · epoch {settings.bundle.epoch}</Badge> : <Badge tone="amber">No bundle reported</Badge>}
        </div>
      </div>
      <button type="button" disabled={settingsLoading || applyLoading} onClick={() => void load()} className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-violet-500 disabled:opacity-50">Reload settings</button>
    </div>
    <ProblemMessage problem={problem} />

    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="font-semibold text-white">Rule settings ({settings.rules.length})</h3>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500"><tr>
            {['Rule', 'Title', 'Category', 'Enabled', 'Severity', 'Upstream'].map(label => <th key={label} className="px-3 py-3 font-medium">{label}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-800">
            {settings.rules.map(rule => {
              const current = draft.rules[rule.id] ?? { enabled: rule.enabled, severity: rule.severity };
              const differsFromUpstream = current.enabled !== rule.upstream.enabled || current.severity !== rule.upstream.severity;
              return <tr key={rule.id}>
                <td className="px-3 py-3 font-mono text-xs text-violet-200">{rule.id}</td>
                <td className="px-3 py-3 text-xs text-slate-500">Not returned by the settings API</td>
                <td className="px-3 py-3 text-slate-400">{readable(rule.group)}</td>
                <td className="px-3 py-3">{canEdit ? <label className="inline-flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={current.enabled} onChange={event => updateDraft(old => ({ ...old, rules: { ...old.rules, [rule.id]: { ...old.rules[rule.id], enabled: event.target.checked } } }))} />{current.enabled ? 'On' : 'Off'}</label> : <Badge tone={current.enabled ? 'green' : 'slate'}>{current.enabled ? 'On' : 'Off'}</Badge>}</td>
                <td className="px-3 py-3">{canEdit ? <select value={current.severity} onChange={event => updateDraft(old => ({ ...old, rules: { ...old.rules, [rule.id]: { ...old.rules[rule.id], severity: event.target.value } } }))} className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200">{['info', 'low', 'medium', 'high', 'critical'].map(value => <option key={value} value={value}>{value}</option>)}</select> : readable(current.severity)}</td>
                <td className="px-3 py-3 text-xs text-slate-500">{differsFromUpstream ? `Upstream: ${rule.upstream.enabled ? 'On' : 'Off'} · ${rule.upstream.severity}` : 'Matches upstream'}{differsFromUpstream && <div>Version {rule.upstream.version}</div>}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </section>

    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="font-semibold text-white">Data settings</h3>
      <ul className="mt-3 divide-y divide-slate-800">
        {DATA_SETTING_INFO.map(setting => <li key={setting.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div><p className="text-sm text-slate-200">{setting.label}</p><p className="mt-1 text-xs text-amber-200/80">{setting.warning}</p></div>
          {canEdit ? <label className="inline-flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={draft.dataSettings[setting.key]} onChange={event => updateDraft(old => ({ ...old, dataSettings: { ...old.dataSettings, [setting.key]: event.target.checked } }))} />{draft.dataSettings[setting.key] ? 'On' : 'Off'}</label>
            : <Badge tone={draft.dataSettings[setting.key] ? 'amber' : 'slate'}>{draft.dataSettings[setting.key] ? 'On' : 'Off'}</Badge>}
        </li>)}
      </ul>
    </section>

    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="font-semibold text-white">Monitor mode</h3>
      {canEdit ? <label className="mt-3 flex flex-wrap items-center gap-3 text-sm text-slate-300">
        <select value={draft.monitorMode} onChange={event => updateDraft(old => ({ ...old, monitorMode: event.target.value as SettingsDraft['monitorMode'] }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"><option value="off">Off</option><option value="monitor">Monitor</option></select>
        <span>Monitor mode records observations; it does not block.</span>
      </label> : <p className="mt-2 text-sm text-slate-300">{readable(draft.monitorMode)}</p>}
      {settings.bundle && <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <InfoCard label="Bundle version" value={settings.bundle.bundle_version} />
        <InfoCard label="Epoch" value={settings.bundle.epoch} />
        <InfoCard label="Issued time" value={displayDate(settings.bundle.issued_at)} />
        <InfoCard label="Enabled rules" value={settings.bundle.enabled_rule_count} />
      </div>}
    </section>

    {canEdit && <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="font-semibold text-white">Review and apply</h3>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" disabled={!dirty || reviewLoading || applyLoading} onClick={() => void reviewChanges()} className="rounded-lg border border-violet-500/50 px-4 py-2 text-sm text-violet-200 hover:bg-violet-500/10 disabled:opacity-40">{reviewLoading ? 'Reviewing…' : 'Review changes'}</button>
      </div>
      {activePlanMatches && plan && <div className="mt-4 rounded-lg border border-slate-700 bg-slate-950/60 p-4">
        <h4 className="font-medium text-white">Review plan</h4>
        <ul className="mt-3 space-y-2 text-sm text-slate-300">
          <li>Rule changes: {plan.rule_changes.length}</li>
          {plan.rule_changes.map(change => <li key={change.id} className="ml-4 text-xs text-slate-400">{change.id}: {change.from.enabled ? 'On' : 'Off'} / {change.from.severity} → {change.to.enabled ? 'On' : 'Off'} / {change.to.severity}</li>)}
          <li>Data settings change: {plan.data_settings_changed ? 'Yes' : 'No'}</li>
          <li>Monitor mode: {readable(plan.monitor.from)} → {readable(plan.monitor.to)}</li>
          <li>Lease changes: {plan.data_settings_changed || plan.monitor.from !== plan.monitor.to || plan.publishes_bundle ? 'Yes' : 'No'}</li>
          <li>New bundle published: {plan.publishes_bundle ? 'Yes' : 'No'}</li>
          <li>Bundle too large to sign: {plan.exceeds_signer_limit ? 'Yes' : 'No'}</li>
          <li>Active machines reached: {plan.active_machine_count}</li>
        </ul>
        <label className="mt-4 block space-y-1 text-xs text-slate-400">Reason required to apply
          <input value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200" />
        </label>
        <button type="button" disabled={!reason.trim() || !activePlanMatches || applyLoading} onClick={() => void applyChanges()} className="mt-3 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40">{applyLoading ? 'Applying…' : 'Apply'}</button>
      </div>}
    </section>}
  </div>;
}

export function SecurityWorkspace({ repositories, role }: { repositories: Repository[]; role: Role }) {
  const [tab, setTab] = useState<SecurityTab>('findings');
  const [urlReady, setUrlReady] = useState(false);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested === 'findings' || requested === 'coverage' || requested === 'settings') setTab(requested);
    setUrlReady(true);
  }, []);

  useEffect(() => {
    if (!urlReady) return;
    const parameters = new URLSearchParams(window.location.search);
    parameters.set('view', 'security');
    parameters.set('tab', tab);
    const query = parameters.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${query}${window.location.hash}`);
  }, [tab, urlReady]);

  const isAuditor = role === 'tenant_auditor';
  return <div className="space-y-5">
    <div role="note" className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-100">
      Monitor mode: TrackAI observes and records; it does not block.
    </div>
    <div role="tablist" aria-label="Security sections" className="flex flex-wrap gap-2 border-b border-slate-800 pb-3">
      {(['findings', 'coverage', 'settings'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`rounded-lg px-4 py-2 text-sm capitalize ${tab === value ? 'bg-violet-500/15 text-violet-200' : 'text-slate-400 hover:bg-slate-900 hover:text-white'}`}>{value}</button>)}
      {isAuditor && <span className="ml-auto self-center text-xs text-slate-500">Auditor · settings are read-only</span>}
    </div>
    {tab === 'findings' && <FindingsTab repositories={repositories} />}
    {tab === 'coverage' && <CoverageTab />}
    {tab === 'settings' && <SettingsTab role={role} />}
  </div>;
}
