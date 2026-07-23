export type MatchableCommit = { sha: string; branch: string | null; authorEmail: string | null };
export type MatchablePullRequest = { id: string; headSha: string | null; mergeCommitSha: string | null; headRef: string | null; authorEmail: string; state: string };

export function selectPullRequestMatch(commit: MatchableCommit, pullRequests: MatchablePullRequest[]) {
  const exact = pullRequests.filter((row) => row.headSha === commit.sha || row.mergeCommitSha === commit.sha);
  if (exact.length === 1) return { pullRequest: exact[0], method: 'sha', confidence: 100 };
  if (exact.length > 1) return null;
  if (commit.branch) {
    const branch = pullRequests.filter((row) => row.headRef === commit.branch);
    if (branch.length === 1) return { pullRequest: branch[0], method: 'branch', confidence: 90 };
    if (branch.length > 1) return null;
  }
  if (commit.authorEmail) {
    const author = pullRequests.filter((row) => row.state.toLowerCase() === 'open'
      && row.authorEmail.toLowerCase() === commit.authorEmail!.toLowerCase());
    if (author.length === 1) return { pullRequest: author[0], method: 'author', confidence: 60 };
  }
  return null;
}
