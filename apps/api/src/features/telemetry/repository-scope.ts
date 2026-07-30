/**
 * Task2's minimum fail-closed repository boundary.
 *
 * Existing tenant repositories remain valid for backwards compatibility.
 * A previously unseen GitHub repository may be auto-discovered only when its
 * owner matches the tenant's configured SCM organization. Task4 replaces this
 * transitional rule with explicit machine/repository grants.
 */
export function repositoryIsInTenantScope(
  normalizedUrl: string,
  enrolledRepositories: ReadonlySet<string>,
  scmOrgIdentifier: string | null,
): boolean {
  if (enrolledRepositories.has(normalizedUrl)) return true;

  const [host, owner] = normalizedUrl.split('/');
  return host === 'github.com'
    && Boolean(owner)
    && Boolean(scmOrgIdentifier)
    && owner === scmOrgIdentifier?.trim().toLowerCase();
}
