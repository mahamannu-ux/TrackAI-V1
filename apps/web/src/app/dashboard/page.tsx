'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

type DashboardView = 'pullRequests' | 'repositories' | 'contributors';

type DashboardRepository = {
  id: string;
  name: string;
  url: string;
  provider: string;
  externalId: string;
};

type DashboardPullRequest = {
  id: string;
  repositoryId: string;
  externalId: string;
  title: string;
  state: string;
  authorEmail: string;
  createdAt: string;
  updatedAt: string;
};

type DashboardContributor = {
  id: string;
  repositoryId: string;
  name: string;
  email: string;
};

type ContributorSummary = DashboardContributor & {
  repositoryIds: string[];
};

function AppIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/20">
      {children}
    </span>
  );
}

function PullRequestStateIcon({ state, className = 'h-4 w-4' }: { state: string; className?: string }) {
  const normalizedState = state.toLowerCase();

  if (normalizedState === 'review' || normalizedState === 'in_review') {
    return (
      <svg className={`${className} text-amber-400`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.75V8l2.25 1.35" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  const color = normalizedState === 'open' ? 'text-emerald-400' : 'text-rose-400';
  return (
    <svg className={`${className} ${color}`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4" cy="12.5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12.5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 5.5v5M8 3.5h1.25A2.75 2.75 0 0 1 12 6.25v4.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m6.75 1.75 1.5 1.75-1.5 1.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusBadge({ state }: { state: string }) {
  const normalizedState = state.toLowerCase();
  const label = normalizedState === 'in_review'
    ? 'In review'
    : normalizedState.charAt(0).toUpperCase() + normalizedState.slice(1);
  const styles = normalizedState === 'open'
    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
    : normalizedState === 'review' || normalizedState === 'in_review'
      ? 'border-amber-500/20 bg-amber-500/10 text-amber-300'
      : 'border-rose-500/20 bg-rose-500/10 text-rose-300';

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium ${styles}`}>
      <PullRequestStateIcon state={state} className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function formatRelativeTime(value: string) {
  const elapsedSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const intervals: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];

  for (const [unit, seconds] of intervals) {
    if (Math.abs(elapsedSeconds) >= seconds) {
      return formatter.format(Math.round(elapsedSeconds / seconds), unit);
    }
  }

  return 'just now';
}

export default function DashboardPage() {
  const router = useRouter();
  const [activeView, setActiveView] = useState<DashboardView>('pullRequests');
  const [organizationName, setOrganizationName] = useState('Workspace');
  const [repositories, setRepositories] = useState<DashboardRepository[]>([]);
  const [pullRequests, setPullRequests] = useState<DashboardPullRequest[]>([]);
  const [contributors, setContributors] = useState<DashboardContributor[]>([]);
  const [selectedPullRequest, setSelectedPullRequest] = useState<DashboardPullRequest | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadWorkspaceData() {
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;

        if (!session) {
          router.replace('/login');
          return;
        }

        const email = session.user.email;
        const domain = email?.split('@')[1]?.trim().toLowerCase();
        if (!email || !domain) {
          throw new Error('The authenticated user does not have a valid corporate email.');
        }

        if (active) setUserEmail(email);

        const { data: tenant, error: tenantError } = await supabase
          .from('sso_tenants')
          .select('id, company_name')
          .eq('domain', domain)
          .maybeSingle();

        if (tenantError) throw tenantError;
        if (!tenant) throw new Error('No workspace is registered for this email domain.');

        const [repositoryResult, pullRequestResult, contributorResult] = await Promise.all([
          supabase
            .from('scm_repositories')
            .select('id, name, url, provider, external_id')
            .eq('tenant_id', tenant.id)
            .order('name'),
          supabase
            .from('scm_pull_requests')
            .select('id, repository_id, external_id, title, state, author_email, created_at, updated_at')
            .eq('tenant_id', tenant.id)
            .order('updated_at', { ascending: false }),
          supabase
            .from('scm_contributors')
            .select('id, repository_id, name, email')
            .eq('tenant_id', tenant.id)
            .order('email'),
        ]);

        if (repositoryResult.error) throw repositoryResult.error;
        if (pullRequestResult.error) throw pullRequestResult.error;
        if (contributorResult.error) throw contributorResult.error;

        if (active) {
          setOrganizationName(tenant.company_name || domain);
          setRepositories((repositoryResult.data ?? []).map((repository) => ({
            id: repository.id,
            name: repository.name,
            url: repository.url,
            provider: repository.provider,
            externalId: repository.external_id,
          })));
          setPullRequests((pullRequestResult.data ?? []).map((pullRequest) => ({
            id: pullRequest.id,
            repositoryId: pullRequest.repository_id,
            externalId: pullRequest.external_id,
            title: pullRequest.title,
            state: pullRequest.state,
            authorEmail: pullRequest.author_email,
            createdAt: pullRequest.created_at,
            updatedAt: pullRequest.updated_at,
          })));
          setContributors((contributorResult.data ?? []).map((contributor) => ({
            id: contributor.id,
            repositoryId: contributor.repository_id,
            name: contributor.name,
            email: contributor.email,
          })));
        }
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error
            ? loadError.message
            : 'Failed to load workspace SCM data.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadWorkspaceData();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') router.replace('/login');
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [router]);

  useEffect(() => {
    if (!selectedPullRequest) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedPullRequest(null);
    };
    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleEscape);
    };
  }, [selectedPullRequest]);

  const repositoriesById = useMemo(
    () => new Map(repositories.map((repository) => [repository.id, repository])),
    [repositories],
  );

  const contributorSummaries = useMemo(() => {
    const contributorsByEmail = new Map<string, ContributorSummary>();
    for (const contributor of contributors) {
      const existingContributor = contributorsByEmail.get(contributor.email);
      if (existingContributor) {
        if (!existingContributor.repositoryIds.includes(contributor.repositoryId)) {
          existingContributor.repositoryIds.push(contributor.repositoryId);
        }
      } else {
        contributorsByEmail.set(contributor.email, {
          ...contributor,
          repositoryIds: [contributor.repositoryId],
        });
      }
    }
    return Array.from(contributorsByEmail.values());
  }, [contributors]);

  const openPullRequestCount = pullRequests.filter(
    (pullRequest) => pullRequest.state.toLowerCase() === 'open',
  ).length;

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#080b12] text-white">
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
          Loading workspace intelligence...
        </div>
      </main>
    );
  }

  const navigationItems: Array<{ id: DashboardView; label: string; count: number; icon: ReactNode }> = [
    {
      id: 'pullRequests',
      label: 'Pull Requests',
      count: pullRequests.length,
      icon: <PullRequestStateIcon state="open" />,
    },
    {
      id: 'repositories',
      label: 'Repositories',
      count: repositories.length,
      icon: (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 2.75A1.75 1.75 0 0 1 4.75 1h7.5v11.25h-7.5A1.75 1.75 0 0 0 3 14V2.75Z" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3 13.75A1.75 1.75 0 0 1 4.75 12h7.5v3h-7.5A1.75 1.75 0 0 1 3 13.25" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      ),
    },
    {
      id: 'contributors',
      label: 'Contributors',
      count: contributorSummaries.length,
      icon: (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3.5 14c.4-2.75 1.9-4 4.5-4s4.1 1.25 4.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-[#080b12] text-slate-100">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-white/[0.06] bg-[#0d111a] lg:flex">
        <div className="border-b border-white/[0.06] px-5 py-5">
          <div className="flex items-center gap-3">
            <AppIcon>
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 11.5 6.25 8 8.5 10.25 13 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="3" cy="11.5" r="1" fill="currentColor" />
                <circle cx="13" cy="5.5" r="1" fill="currentColor" />
              </svg>
            </AppIcon>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{organizationName}</p>
              <p className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-slate-500">TrackAI workspace</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-5">
          <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">Workspace</p>
          <div className="mt-2 space-y-1">
            {navigationItems.map((item) => {
              const isActive = activeView === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveView(item.id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${isActive
                    ? 'bg-indigo-500/15 text-indigo-200 ring-1 ring-inset ring-indigo-400/15'
                    : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'}`}
                >
                  <span className={isActive ? 'text-indigo-300' : 'text-slate-500'}>{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${isActive ? 'bg-indigo-400/10 text-indigo-300' : 'bg-white/[0.04] text-slate-600'}`}>
                    {item.count}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="mt-8 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">Operations</p>
          <div className="mt-2 space-y-1">
            {['Live', 'Report', 'Sessions', 'Settings'].map((item) => (
              <button
                key={item}
                type="button"
                title={`${item} is coming soon`}
                className="flex w-full cursor-default items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-slate-600"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-slate-700" />
                <span className="flex-1">{item}</span>
                <span className="text-[9px] uppercase tracking-wider text-slate-700">Soon</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="border-t border-white/[0.06] p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-slate-300">
              {userEmail?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-slate-300">{userEmail}</p>
              <button type="button" onClick={handleSignOut} className="mt-0.5 text-xs text-slate-600 hover:text-slate-300">
                Sign out
              </button>
            </div>
          </div>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-[#080b12]/90 px-4 py-4 backdrop-blur-xl sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-indigo-300 lg:hidden">{organizationName}</p>
              <h1 className="truncate text-lg font-semibold text-white">
                {activeView === 'pullRequests' ? 'Pull Requests' : activeView === 'repositories' ? 'Repositories' : 'Contributors'}
              </h1>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-xs text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]" />
              Synced with GitHub
            </div>
          </div>
          <div className="mx-auto mt-4 flex max-w-7xl gap-2 overflow-x-auto lg:hidden">
            {navigationItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveView(item.id)}
                className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs ${activeView === item.id ? 'bg-indigo-500/15 text-indigo-200' : 'bg-white/[0.03] text-slate-500'}`}
              >
                {item.label} · {item.count}
              </button>
            ))}
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          {error && (
            <div className="mb-6 rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-300">
              {error}
            </div>
          )}

          {activeView === 'pullRequests' && (
            <section>
              <div className="mb-5 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-4">
                  <p className="text-xs text-slate-500">Total pull requests</p>
                  <p className="mt-1 text-2xl font-semibold text-white">{pullRequests.length}</p>
                </div>
                <div className="rounded-xl border border-emerald-500/10 bg-emerald-500/[0.035] p-4">
                  <p className="text-xs text-slate-500">Currently open</p>
                  <p className="mt-1 text-2xl font-semibold text-emerald-300">{openPullRequestCount}</p>
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-4">
                  <p className="text-xs text-slate-500">Repositories covered</p>
                  <p className="mt-1 text-2xl font-semibold text-white">{repositories.length}</p>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#0d111a]">
                <div className="hidden grid-cols-[minmax(0,1fr)_170px_150px_110px] border-b border-white/[0.06] px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600 md:grid">
                  <span>Pull request</span>
                  <span>Repository</span>
                  <span>Author</span>
                  <span>Updated</span>
                </div>
                {pullRequests.length > 0 ? (
                  <div className="divide-y divide-white/[0.05]">
                    {pullRequests.map((pullRequest) => {
                      const repository = repositoriesById.get(pullRequest.repositoryId);
                      return (
                        <button
                          key={pullRequest.id}
                          type="button"
                          onClick={() => setSelectedPullRequest(pullRequest)}
                          className="grid w-full gap-3 px-4 py-4 text-left transition hover:bg-white/[0.035] md:grid-cols-[minmax(0,1fr)_170px_150px_110px] md:items-center md:px-5"
                        >
                          <div className="flex min-w-0 items-start gap-3">
                            <PullRequestStateIcon state={pullRequest.state} className="mt-0.5 h-4 w-4 shrink-0" />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-slate-200">{pullRequest.title}</p>
                              <p className="mt-1 text-xs text-slate-600">#{pullRequest.externalId}</p>
                            </div>
                          </div>
                          <p className="truncate text-xs text-slate-400">{repository?.name || 'Unknown repository'}</p>
                          <p className="truncate text-xs text-slate-500">{pullRequest.authorEmail}</p>
                          <div className="flex items-center justify-between gap-2 md:block">
                            <span className="md:hidden"><StatusBadge state={pullRequest.state} /></span>
                            <p className="text-xs text-slate-600">{formatRelativeTime(pullRequest.updatedAt)}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-6 py-16 text-center">
                    <PullRequestStateIcon state="open" className="mx-auto h-7 w-7 opacity-60" />
                    <p className="mt-3 text-sm text-slate-400">No pull requests captured yet.</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {activeView === 'repositories' && (
            <section>
              <div className="mb-6">
                <p className="text-sm text-slate-500">Repositories currently sending SCM activity into this workspace.</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {repositories.map((repository) => {
                  const repositoryPullRequests = pullRequests.filter(
                    (pullRequest) => pullRequest.repositoryId === repository.id,
                  );
                  return (
                    <article key={repository.id} className="rounded-xl border border-white/[0.07] bg-[#0d111a] p-5 transition hover:border-indigo-400/20">
                      <div className="flex items-start justify-between gap-4">
                        <AppIcon>
                          <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M3 2.75A1.75 1.75 0 0 1 4.75 1h7.5v11.25h-7.5A1.75 1.75 0 0 0 3 14V2.75Z" stroke="currentColor" strokeWidth="1.4" />
                            <path d="M3 13.75A1.75 1.75 0 0 1 4.75 12h7.5v3h-7.5A1.75 1.75 0 0 1 3 13.25" stroke="currentColor" strokeWidth="1.4" />
                          </svg>
                        </AppIcon>
                        <span className="rounded-full bg-white/[0.04] px-2 py-1 text-[10px] uppercase tracking-wider text-slate-500">
                          {repository.provider}
                        </span>
                      </div>
                      <a href={repository.url} target="_blank" rel="noreferrer" className="mt-4 block truncate text-sm font-semibold text-slate-200 hover:text-indigo-300">
                        {repository.name}
                      </a>
                      <p className="mt-1 text-xs text-slate-600">External ID {repository.externalId}</p>
                      <div className="mt-5 flex items-center gap-4 border-t border-white/[0.05] pt-4 text-xs text-slate-500">
                        <span>{repositoryPullRequests.length} pull requests</span>
                        <span>{repositoryPullRequests.filter((pullRequest) => pullRequest.state === 'open').length} open</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {activeView === 'contributors' && (
            <section>
              <div className="mb-6">
                <p className="text-sm text-slate-500">People observed contributing pull requests across this workspace.</p>
              </div>
              <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#0d111a]">
                {contributorSummaries.length > 0 ? (
                  <div className="divide-y divide-white/[0.05]">
                    {contributorSummaries.map((contributor) => (
                      <div key={contributor.email} className="flex items-center gap-4 px-5 py-4">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-xs font-semibold text-indigo-300 ring-1 ring-inset ring-indigo-400/15">
                          {contributor.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-200">{contributor.name}</p>
                          <p className="mt-0.5 truncate text-xs text-slate-500">{contributor.email}</p>
                        </div>
                        <div className="hidden text-right sm:block">
                          <p className="text-xs text-slate-400">
                            {contributor.repositoryIds.length} {contributor.repositoryIds.length === 1 ? 'repository' : 'repositories'}
                          </p>
                          <p className="mt-0.5 max-w-64 truncate text-xs text-slate-600">
                            {contributor.repositoryIds.map((id) => repositoriesById.get(id)?.name).filter(Boolean).join(', ')}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="px-6 py-16 text-center text-sm text-slate-500">No contributors have been registered yet.</p>
                )}
              </div>
            </section>
          )}
        </main>
      </div>

      {selectedPullRequest && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="pull-request-drawer-title">
          <button
            type="button"
            aria-label="Close pull request details"
            onClick={() => setSelectedPullRequest(null)}
            className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
          />
          <aside className="relative flex h-full w-full max-w-xl flex-col border-l border-white/[0.08] bg-[#0d111a] shadow-2xl shadow-black/60">
            <div className="border-b border-white/[0.07] px-6 py-5">
              <div className="flex items-start gap-3">
                <PullRequestStateIcon state={selectedPullRequest.state} className="mt-1 h-5 w-5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-slate-600">
                    {repositoriesById.get(selectedPullRequest.repositoryId)?.name || 'Repository'} · #{selectedPullRequest.externalId}
                  </p>
                  <h2 id="pull-request-drawer-title" className="mt-1 text-lg font-semibold leading-6 text-white">
                    {selectedPullRequest.title}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedPullRequest(null)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-white/[0.05] hover:text-white"
                  aria-label="Close"
                >
                  <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <StatusBadge state={selectedPullRequest.state} />
                <span className="text-xs text-slate-500">Opened by {selectedPullRequest.authorEmail}</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-4">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-slate-600">Created</p>
                  <p className="mt-2 text-sm text-slate-300">{formatDate(selectedPullRequest.createdAt)}</p>
                </div>
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-4">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-slate-600">Last activity</p>
                  <p className="mt-2 text-sm text-slate-300">{formatRelativeTime(selectedPullRequest.updatedAt)}</p>
                </div>
              </div>

              <section className="mt-7">
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Pull request details</h3>
                <dl className="mt-3 divide-y divide-white/[0.05] rounded-xl border border-white/[0.06]">
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <dt className="text-xs text-slate-600">Repository</dt>
                    <dd className="truncate text-xs text-slate-300">{repositoriesById.get(selectedPullRequest.repositoryId)?.name || 'Unknown'}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <dt className="text-xs text-slate-600">Author</dt>
                    <dd className="truncate text-xs text-slate-300">{selectedPullRequest.authorEmail}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <dt className="text-xs text-slate-600">External ID</dt>
                    <dd className="font-mono text-xs text-slate-400">{selectedPullRequest.externalId}</dd>
                  </div>
                </dl>
              </section>

              <section className="mt-7 rounded-xl border border-dashed border-white/[0.08] bg-white/[0.015] p-5">
                <p className="text-sm font-medium text-slate-400">Session intelligence</p>
                <p className="mt-2 text-xs leading-5 text-slate-600">
                  Agent sessions, token usage, review costs, and policy signals will appear here as those data sources come online.
                </p>
              </section>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
