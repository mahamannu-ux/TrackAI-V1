import React from 'react';
import type { AdminSecurityFindingResources } from '@/lib/api';

type Finding = AdminSecurityFindingResources['findings'][number];

export function AdminSecurityFindingRow({ finding, repositoryName }: {
  finding: Finding;
  repositoryName: string | null;
}) {
  const occurred = finding.occurredAt
    ? new Date(finding.occurredAt).toLocaleString()
    : 'Unavailable';
  return <tr>
    <td className="px-5 py-4 text-slate-500">{occurred}</td>
    <td className="px-5 py-4"><div className="font-medium text-white">{finding.ruleId.replace('trackai.exec.', '').replaceAll('_', ' ')}</div><div className="text-xs text-slate-500">Version {finding.ruleVersion} · {finding.phase?.replaceAll('_', ' ') ?? 'Phase not reported'}</div></td>
    <td className="px-5 py-4">{finding.ruleSeverity}</td>
    <td className="px-5 py-4 text-slate-400">{repositoryName ?? (finding.repositoryId ? finding.repositoryId.slice(0, 8) : 'Not in an enrolled repository')}</td>
    <td className="px-5 py-4 text-slate-400">{finding.operatingSystem}</td>
    <td className="px-5 py-4">{finding.effect ?? 'Not reported'}</td>
  </tr>;
}
