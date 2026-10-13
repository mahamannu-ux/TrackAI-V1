'use client';

import { useEffect, useState } from 'react';
import { AttestaApiError, getAttestaSubject, type AttestaStatement } from '@/lib/api';

function Badge({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'green' | 'amber' }) {
  const styles = {
    slate: 'bg-slate-800 text-slate-300',
    green: 'bg-emerald-500/10 text-emerald-300',
    amber: 'bg-amber-500/10 text-amber-300',
  };
  return <span className={`rounded-full px-2.5 py-1 text-xs ${styles[tone]}`}>{children}</span>;
}

function date(value: string | null) {
  return value ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Unavailable';
}

function kindLabel(kind: string): string {
  if (kind === 'commit_observed') return 'Commit observed';
  if (kind === 'pr_merged') return 'Merged';
  if (kind === 'deployed') return 'Deployed to production';
  if (kind === 'period_report') return 'Period report';
  return kind;
}

function anchorBadge(status: AttestaStatement['anchor_status']): { label: string; tone: 'green' | 'amber' } {
  if (status === 'anchored') return { label: 'Signed · anchored', tone: 'green' };
  if (status === 'pending') return { label: 'Signed · anchoring pending', tone: 'amber' };
  return { label: 'Signed · anchor overdue', tone: 'amber' };
}

function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, 12);
}

export function AttestationCard({ repositoryId, sha }: { repositoryId: string | null; sha: string | null }) {
  const [statements, setStatements] = useState<AttestaStatement[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AttestaApiError | null>(null);

  useEffect(() => {
    if (!repositoryId || !sha) {
      setStatements(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatements(null);
    void getAttestaSubject(repositoryId, sha).then(
      (response) => {
        if (cancelled) return;
        setStatements([...response.statements].sort((a, b) => a.seq - b.seq));
        setLoading(false);
      },
      (cause) => {
        if (cancelled) return;
        setError(cause instanceof AttestaApiError
          ? cause
          : new AttestaApiError('Attestation unavailable', 'ATTESTA_API_INTERNAL', 0, null));
        setLoading(false);
      },
    );
    return () => { cancelled = true; };
  }, [repositoryId, sha]);

  if (!repositoryId || !sha) return null;

  if (loading) {
    return <div><Badge tone="slate">Checking attestation…</Badge></div>;
  }

  if (error) {
    if (error.code === 'ATTESTA_API_NOT_FOUND' || error.status === 404) {
      return <div className="space-y-2">
        <div><Badge tone="slate">Not attested yet</Badge></div>
        <p className="text-sm text-slate-500">Attesta signs a commit after TrackAI observes it. This usually takes a few minutes.</p>
      </div>;
    }
    if (error.status === 401 || error.status === 403) {
      return <p className="text-sm text-slate-500">Attestation details need the administrator or auditor role.</p>;
    }
    return <div className="space-y-2">
      <div><Badge tone="amber">Attestation unavailable</Badge></div>
      <p className="text-sm text-slate-500">Could not load attestation (code <span className="font-mono">{error.code}</span>).</p>
    </div>;
  }

  if (!statements) return null;

  return <div className="space-y-2">
    {statements.map((statement) => {
      const anchor = anchorBadge(statement.anchor_status);
      return <div key={statement.statement_digest} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm">
        <span className="font-medium text-slate-200">{kindLabel(statement.statement_kind)}</span>
        <span className="text-xs text-slate-500">{date(statement.recorded_at)}</span>
        <span className="font-mono text-xs text-violet-300">{shortDigest(statement.statement_digest)}</span>
        <Badge tone={anchor.tone}>{anchor.label}</Badge>
      </div>;
    })}
    <p className="text-xs text-slate-600">Status from TrackAI&apos;s records. Run Verify in Administration → Attestation to check signatures and anchors.</p>
  </div>;
}
