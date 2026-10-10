'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  applyFleetOffboard,
  assignFleetConfiguration,
  createFleetConfiguration,
  getFleetMachines,
  previewFleetOffboard,
  type FleetChannel,
  type FleetConfiguration,
  type FleetMachine,
  type FleetMachineState,
  type FleetOffboardPreview,
  type FleetOffboardResult,
} from '@/lib/api';

const FLEET_STATES: FleetMachineState[] = [
  'current', 'stale', 'unreported', 'unavailable', 'mismatch', 'revoked',
];

const FLEET_CHANNELS: FleetChannel[] = ['latest', 'next', 'enterprise-latest', 'enterprise-next'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function Badge({ children, tone = 'slate' }: {
  children: React.ReactNode; tone?: 'slate' | 'green' | 'amber' | 'violet' | 'rose' | 'cyan';
}) {
  const styles = {
    slate: 'bg-slate-800 text-slate-300', green: 'bg-emerald-500/10 text-emerald-300',
    amber: 'bg-amber-500/10 text-amber-300', violet: 'bg-violet-500/10 text-violet-300',
    rose: 'bg-rose-500/10 text-rose-300', cyan: 'bg-cyan-500/10 text-cyan-300',
  };
  return <span className={`rounded-full px-2.5 py-1 text-xs ${styles[tone]}`}>{children}</span>;
}

function stateTone(state: FleetMachineState): 'slate' | 'green' | 'amber' | 'violet' | 'rose' | 'cyan' {
  if (state === 'current') return 'green';
  if (state === 'stale') return 'amber';
  if (state === 'unreported') return 'cyan';
  if (state === 'mismatch') return 'violet';
  if (state === 'revoked') return 'slate';
  return 'rose';
}

function text(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'Unavailable';
  if (typeof value === 'string' && !value) return 'Unavailable';
  return String(value);
}

function date(value: string | null | undefined): string {
  if (!value) return 'Unavailable';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'Unavailable';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

export function FleetWorkspace() {
  const [machines, setMachines] = useState<FleetMachine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<'all' | FleetMachineState>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);

  const [version, setVersion] = useState('');
  const [channel, setChannel] = useState<FleetChannel>('enterprise-latest');
  const [ring, setRing] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [createReason, setCreateReason] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [sessionConfigs, setSessionConfigs] = useState<FleetConfiguration[]>([]);

  const [assignConfigId, setAssignConfigId] = useState('');
  const [assignReason, setAssignReason] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);

  const [preview, setPreview] = useState<FleetOffboardPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [offboardReason, setOffboardReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<FleetOffboardResult | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const response = await getFleetMachines();
      setMachines(response.machines);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Fleet inventory is unavailable.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const counts = useMemo(() => {
    const result: Record<FleetMachineState, number> = {
      current: 0, stale: 0, unreported: 0, unavailable: 0, mismatch: 0, revoked: 0,
    };
    for (const machine of machines ?? []) result[machine.status] += 1;
    return result;
  }, [machines]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (machines ?? []).filter(machine => {
      if (stateFilter !== 'all' && machine.status !== stateFilter) return false;
      if (!query) return true;
      return [machine.displayName, machine.installationId, machine.id]
        .some(value => value.toLowerCase().includes(query));
    });
  }, [machines, stateFilter, search]);

  const selected = useMemo(
    () => (machines ?? []).find(machine => machine.id === selectedId) ?? null,
    [machines, selectedId],
  );

  const knownConfigs = useMemo(() => {
    const known = new Map<string, { epoch: number; label: string }>();
    for (const machine of machines ?? []) {
      const desired = machine.desiredConfiguration;
      if (desired && !known.has(desired.id)) {
        known.set(desired.id, {
          epoch: desired.epoch,
          label: `${desired.targetClientVersion} · ${desired.channel} · epoch ${desired.epoch}`,
        });
      }
    }
    for (const config of sessionConfigs) {
      if (!known.has(config.id)) {
        known.set(config.id, {
          epoch: config.epoch,
          label: `${config.targetClientVersion} · ${config.channel} · epoch ${config.epoch} (created here)`,
        });
      }
    }
    return known;
  }, [machines, sessionConfigs]);

  const rollbackTargets = useMemo(() => {
    const target = assignConfigId.trim();
    const known = knownConfigs.get(target);
    if (!known) return [];
    return checkedIds.filter(id => {
      const machine = (machines ?? []).find(row => row.id === id);
      const desiredEpoch = machine?.desiredConfiguration?.epoch;
      return desiredEpoch !== undefined && known.epoch < desiredEpoch;
    });
  }, [assignConfigId, checkedIds, knownConfigs, machines]);

  function toggleChecked(id: string): void {
    setCheckedIds(current => (
      current.includes(id) ? current.filter(row => row !== id) : [...current, id]
    ));
  }

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setCreateError(null);
    const targetClientVersion = version.trim();
    if (!targetClientVersion || targetClientVersion.length > 64) {
      setCreateError('Enter a client version up to 64 characters.');
      return;
    }
    if (!FLEET_CHANNELS.includes(channel)) {
      setCreateError('Select a frozen update channel.');
      return;
    }
    const trimmedRing = ring.trim();
    if (trimmedRing.length > 64) {
      setCreateError('Ring must be 64 characters or fewer.');
      return;
    }
    let validUntilIso: string | null = null;
    if (validUntil) {
      const parsed = new Date(validUntil);
      if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        setCreateError('Valid-until must be a future date when provided.');
        return;
      }
      validUntilIso = parsed.toISOString();
    }
    if (!createReason.trim()) {
      setCreateError('Enter an audit reason before creating this configuration.');
      return;
    }
    setCreateBusy(true);
    try {
      const response = await createFleetConfiguration({
        targetClientVersion,
        channel,
        ring: trimmedRing ? trimmedRing : null,
        validUntil: validUntilIso,
        reason: createReason.trim(),
      });
      setSessionConfigs(current => [response.configuration, ...current]);
      setAssignConfigId(response.configuration.id);
      setVersion('');
      setRing('');
      setValidUntil('');
      setCreateReason('');
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : 'Configuration creation failed.');
    } finally {
      setCreateBusy(false);
    }
  }

  async function assign(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setAssignError(null);
    setAssignSuccess(null);
    const configurationId = assignConfigId.trim();
    if (!UUID.test(configurationId)) {
      setAssignError('Enter a valid configuration UUID.');
      return;
    }
    const uniqueIds = [...new Set(checkedIds)];
    if (uniqueIds.length < 1 || uniqueIds.length > 100) {
      setAssignError('Select 1 to 100 machines using the inventory checkboxes.');
      return;
    }
    if (!assignReason.trim()) {
      setAssignError('Enter an audit reason before assigning this configuration.');
      return;
    }
    setAssignBusy(true);
    try {
      await assignFleetConfiguration({ configurationId, machineIds: uniqueIds, reason: assignReason.trim() });
      const rollbackNote = rollbackTargets.length > 0
        ? ` This returns ${rollbackTargets.length} machine${rollbackTargets.length === 1 ? '' : 's'} to an older configuration (rollback).`
        : '';
      setAssignSuccess(`Assigned to ${uniqueIds.length} machine${uniqueIds.length === 1 ? '' : 's'}.${rollbackNote}`);
      setAssignReason('');
      setCheckedIds([]);
      await load();
    } catch (cause) {
      setAssignError(cause instanceof Error ? cause.message : 'Configuration assignment failed.');
    } finally {
      setAssignBusy(false);
    }
  }

  async function runPreview(): Promise<void> {
    if (!selected) return;
    setPreview(null);
    setPreviewError(null);
    setApplyResult(null);
    setConfirmed(false);
    setPreviewBusy(true);
    try {
      setPreview(await previewFleetOffboard(selected.id));
    } catch (cause) {
      setPreviewError(cause instanceof Error ? cause.message : 'Offboard preview failed.');
    } finally {
      setPreviewBusy(false);
    }
  }

  async function apply(): Promise<void> {
    if (!selected || !preview || preview.machine.id !== selected.id) return;
    setApplyError(null);
    if (!offboardReason.trim()) {
      setApplyError('Enter an audit reason before applying offboard.');
      return;
    }
    if (!confirmed) {
      setApplyError('Confirm explicitly that this machine should lose server access.');
      return;
    }
    setApplyBusy(true);
    try {
      setApplyResult(await applyFleetOffboard(selected.id, offboardReason.trim()));
      setOffboardReason('');
      setConfirmed(false);
      await load();
    } catch (cause) {
      setApplyError(cause instanceof Error ? cause.message : 'Offboard apply failed.');
    } finally {
      setApplyBusy(false);
    }
  }

  const previewMatchesSelection = Boolean(preview && selected && preview.machine.id === selected.id);

  return <div className="space-y-4">
    <div className="flex items-center justify-between">
      <div>
        <h2 className="font-semibold text-white">Fleet</h2>
        <p className="mt-1 text-sm text-slate-500">
          Desired and observed state for managed installations. Reconciliation is unavailable
          until the later MDM and Task8 integration; MDM evidence never grants access.
        </p>
      </div>
      <button onClick={() => void load()} disabled={loading} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 disabled:opacity-50">
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
    {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>}

    <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
      {FLEET_STATES.map(state => (
        <div key={state} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="text-xs uppercase tracking-wider text-slate-500">{state}</div>
          <div className="mt-2 text-xl font-semibold text-white">{machines ? counts[state] : 'Unavailable'}</div>
        </div>
      ))}
    </div>

    <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:grid-cols-[1fr_auto]">
      <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Filter by name, installation, or machine ID" aria-label="Filter fleet inventory" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" />
      <div className="flex flex-wrap gap-1 rounded-lg border border-slate-700 bg-slate-950 p-1">
        {(['all', ...FLEET_STATES] as const).map(option => (
          <button key={option} type="button" onClick={() => setStateFilter(option)} className={`rounded-md px-2.5 py-1.5 text-xs capitalize ${stateFilter === option ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}>
            {option}
          </button>
        ))}
      </div>
    </div>

    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
        <div className="border-b border-slate-800 px-4 py-3 text-xs uppercase tracking-wider text-slate-500">
          {filtered.length} of {machines?.length ?? 'Unavailable'} machines{checkedIds.length > 0 && ` · ${checkedIds.length} selected for assignment`}
        </div>
        <div className="max-h-[36rem] divide-y divide-slate-800 overflow-y-auto">
          {filtered.map(machine => (
            <div key={machine.id} className={`flex items-start gap-3 p-4 ${selectedId === machine.id ? 'bg-violet-500/10' : ''}`}>
              <input type="checkbox" checked={checkedIds.includes(machine.id)} onChange={() => toggleChecked(machine.id)} aria-label={`Select ${machine.displayName} for assignment`} className="mt-1" />
              <button type="button" onClick={() => setSelectedId(machine.id)} className="min-w-0 flex-1 text-left">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-white">{machine.displayName}</div>
                    <div className="mt-1 truncate font-mono text-xs text-slate-500">{machine.installationId}</div>
                  </div>
                  <Badge tone={stateTone(machine.status)}>{machine.status}</Badge>
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  Desired: {machine.desiredConfiguration ? `epoch ${machine.desiredConfiguration.epoch} · ${machine.desiredConfiguration.targetClientVersion}` : 'Unavailable'}
                  {' · '}Observed: {machine.observed ? text(machine.observed.gitaiVersion) : 'Unavailable'}
                </div>
              </button>
            </div>
          ))}
          {filtered.length === 0 && <div className="p-6 text-sm text-slate-500">No machines match this filter.</div>}
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h3 className="font-semibold text-white">Selected machine</h3>
          {!selected && <p className="mt-2 text-sm text-slate-500">Select a machine to inspect safe inventory metadata.</p>}
          {selected && <div className="mt-3 space-y-2 text-sm text-slate-300">
            <div><span className="text-slate-500">Display: </span>{selected.displayName}</div>
            <div><span className="text-slate-500">Installation: </span><span className="font-mono text-xs">{selected.installationId}</span></div>
            <div><span className="text-slate-500">State: </span><Badge tone={stateTone(selected.status)}>{selected.status}</Badge></div>
            {selected.status === 'mismatch' && <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 text-xs text-violet-200">Desired configuration differs from what the machine last acknowledged. Investigate; a mismatch is not proof of compromise.</div>}
            <div><span className="text-slate-500">Desired: </span>{selected.desiredConfiguration ? `${selected.desiredConfiguration.targetClientVersion} · ${selected.desiredConfiguration.channel} · epoch ${selected.desiredConfiguration.epoch}${selected.desiredConfiguration.ring ? ` · ring ${selected.desiredConfiguration.ring}` : ''}` : 'Unavailable'}</div>
            <div><span className="text-slate-500">Platform: </span>{text(selected.observed?.platform)} · {text(selected.observed?.osVersion)} · {text(selected.observed?.architecture)}</div>
            <div><span className="text-slate-500">Client: </span>{text(selected.observed?.gitaiVersion)} · service {text(selected.observed?.serviceState)}</div>
            <div><span className="text-slate-500">Acknowledged: </span>{selected.observed?.acknowledgedConfigurationId ? `${selected.observed.acknowledgedConfigurationId.slice(0, 8)} · epoch ${text(selected.observed.acknowledgedEpoch)} · ${text(selected.observed.resultCode)}` : 'Unavailable'}</div>
            <div><span className="text-slate-500">Queue: </span>{selected.observed?.queue ? `retryable ${selected.observed.queue.pendingRetryable} · waiting ${selected.observed.queue.waitingRetry} · processing ${selected.observed.queue.processing} · quarantined ${selected.observed.queue.quarantined} · errors ${selected.observed.queue.rowsWithErrors}` : 'Unavailable'}</div>
            <div><span className="text-slate-500">MDM: </span>{text(selected.observed?.mdmDeviceReference)} · {text(selected.observed?.mdmUserReference)} ({text(selected.observed?.assignmentEvidence?.source)})</div>
            <div><span className="text-slate-500">Reconciliation: </span>unavailable — MDM-to-TrackAI comparison arrives with the later MDM and Task8 integration.</div>
            <div><span className="text-slate-500">Delivery health: </span>{selected.deliveryHealth.status}{selected.deliveryHealth.status !== 'unavailable' && ` · received ${date(selected.deliveryHealth.receivedAt)}`}</div>
            <div><span className="text-slate-500">Last report: </span>{date(selected.observed?.lastReportAt)}</div>
          </div>}
        </div>

        <form onSubmit={event => void create(event)} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h3 className="font-semibold text-white">Create configuration</h3>
          <p className="text-xs text-slate-500">The server snapshots current grants and Task6 monitor state at creation. No configuration-history list exists: only IDs visible above plus ones created here are offered.</p>
          <label className="block text-xs text-slate-400">Target client version<input required value={version} onChange={event => setVersion(event.target.value)} placeholder="for example 1.4.0" aria-label="Target client version" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
          <label className="block text-xs text-slate-400">Channel<select value={channel} onChange={event => setChannel(event.target.value as FleetChannel)} aria-label="Update channel" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">{FLEET_CHANNELS.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
          <label className="block text-xs text-slate-400">Ring (optional)<input value={ring} onChange={event => setRing(event.target.value)} placeholder="for example pilot" aria-label="Rollout ring" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
          <label className="block text-xs text-slate-400">Valid until (optional, future)<input type="datetime-local" value={validUntil} onChange={event => setValidUntil(event.target.value)} aria-label="Valid until" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
          <label className="block text-xs text-slate-400">Audit reason<input required value={createReason} onChange={event => setCreateReason(event.target.value)} placeholder="Why this configuration exists" aria-label="Creation reason" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
          {createError && <div className="rounded-lg border border-rose-500/30 p-3 text-xs text-rose-200">{createError}</div>}
          <button disabled={createBusy} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{createBusy ? 'Creating…' : 'Create configuration'}</button>
          {sessionConfigs.length > 0 && <div className="text-xs text-slate-500">Created this session: {sessionConfigs.map(config => <span key={config.id} className="mr-2 font-mono">{config.id.slice(0, 8)} (epoch {config.epoch})</span>)}</div>}
        </form>

        <form onSubmit={event => void assign(event)} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h3 className="font-semibold text-white">Assign configuration</h3>
          <label className="block text-xs text-slate-400">Configuration UUID<input required value={assignConfigId} onChange={event => setAssignConfigId(event.target.value)} placeholder="Configuration UUID" aria-label="Configuration UUID" list="fleet-known-configs" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-white" /></label>
          <datalist id="fleet-known-configs">{[...knownConfigs.entries()].map(([id, info]) => <option key={id} value={id}>{info.label}</option>)}</datalist>
          <p className="text-xs text-slate-500">Assigning an older retained configuration is a rollback. {rollbackTargets.length > 0 && <span className="text-amber-300">This is a rollback for {rollbackTargets.length} selected machine{rollbackTargets.length === 1 ? '' : 's'}.</span>}{assignConfigId.trim() && !knownConfigs.has(assignConfigId.trim()) && ' This ID is not in current inventory or this session; the server still validates it.'}</p>
          <div className="text-xs text-slate-500">{checkedIds.length} machine{checkedIds.length === 1 ? '' : 's'} selected (1–100).</div>
          <label className="block text-xs text-slate-400">Audit reason<input required value={assignReason} onChange={event => setAssignReason(event.target.value)} placeholder="Why these machines move" aria-label="Assignment reason" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
          {assignError && <div className="rounded-lg border border-rose-500/30 p-3 text-xs text-rose-200">{assignError}</div>}
          {assignSuccess && <div className="rounded-lg border border-emerald-500/30 p-3 text-xs text-emerald-200">{assignSuccess}</div>}
          <button disabled={assignBusy} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{assignBusy ? 'Assigning…' : 'Assign to selected machines'}</button>
        </form>

        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h3 className="font-semibold text-white">Offboard machine</h3>
          <p className="text-xs text-slate-500">Preview first; preview never mutates. Apply revokes server access immediately; local and MDM cleanup are best-effort evidence.</p>
          <button disabled={!selected || previewBusy} onClick={() => void runPreview()} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 disabled:opacity-50">{previewBusy ? 'Loading preview…' : selected ? `Preview offboard for ${selected.displayName}` : 'Select a machine first'}</button>
          {previewError && <div className="rounded-lg border border-rose-500/30 p-3 text-xs text-rose-200">{previewError}</div>}
          {preview && selected && preview.machine.id === selected.id && <div className="space-y-2 text-sm text-slate-300">
            <div><span className="text-slate-500">Machine: </span>{preview.machine.displayName} (<span className="font-mono text-xs">{preview.machine.installationId}</span>)</div>
            <div><span className="text-slate-500">Active credentials: </span>{preview.activeCredentialCount} · <span className="text-slate-500">Active grants: </span>{preview.activeGrantCount}</div>
            <div><span className="text-slate-500">Desired configuration: </span>{text(preview.desiredConfigurationId)}</div>
            <div><span className="text-slate-500">Local cleanup: </span>{preview.localCleanup}</div>
            <label className="block text-xs text-slate-400">Audit reason<input required value={offboardReason} onChange={event => setOffboardReason(event.target.value)} placeholder="Why this machine is offboarded" aria-label="Offboard reason" className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
            <label className="flex items-start gap-2 text-xs text-slate-300"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-0.5" />I confirm this machine should immediately lose server access.</label>
            {applyError && <div className="rounded-lg border border-rose-500/30 p-3 text-xs text-rose-200">{applyError}</div>}
            <button disabled={applyBusy || !previewMatchesSelection || !offboardReason.trim() || !confirmed} onClick={() => void apply()} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{applyBusy ? 'Applying…' : 'Apply offboard'}</button>
          </div>}
          {applyResult && <div className="space-y-1 rounded-lg border border-slate-700 p-3 text-xs">
            <div className="text-emerald-300">Server revocation: {applyResult.serverRevocation} (authoritative).</div>
            <div className="text-amber-300">Local cleanup: {applyResult.localCleanup} — not success.</div>
            <div className="text-amber-300">MDM cleanup: {applyResult.mdmCleanup} — not success, not requested.</div>
          </div>}
        </div>
      </div>
    </div>
  </div>;
}
