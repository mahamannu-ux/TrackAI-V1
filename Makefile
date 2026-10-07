# TrackAI: agent worktrees (agent-kit scripts/worktree.mk). Run from the main checkout.
#   make worktree M=Task15a-attesta-chain        -> ~/AIProjects/TrackAI-wt/Task15a-attesta-chain on task/Task15a-attesta-chain
#   make gitai-worktree M=Task15c-attesta-client -> ~/AIProjects/TrackAI-wt/Task15c-attesta-client-gitai (GitAI fork)
#   make worktree-rm M=<name> | gitai-worktree-rm M=<name> | worktree-list
WORKTREE_ROOT := ~/AIProjects/TrackAI-wt
BRANCH_PREFIX := task/
GITAI_REPO := ~/AIProjects/git-ai

.PHONY: help gitai-worktree gitai-worktree-rm
help:
	@sed -n '2,4p' Makefile

include scripts/worktree.mk

gitai-worktree:
	@test -n "$(M)" || { echo "usage: make gitai-worktree M=<name>" >&2; exit 2; }
	$(MAKE) -C $(GITAI_REPO) -f $(CURDIR)/scripts/worktree.mk worktree M=$(M)-gitai \
		WORKTREE_ROOT=$(WORKTREE_ROOT) BRANCH_PREFIX=$(BRANCH_PREFIX) BASE=$${BASE:-main}

gitai-worktree-rm:
	@test -n "$(M)" || { echo "usage: make gitai-worktree-rm M=<name>" >&2; exit 2; }
	$(MAKE) -C $(GITAI_REPO) -f $(CURDIR)/scripts/worktree.mk worktree-rm M=$(M)-gitai \
		WORKTREE_ROOT=$(WORKTREE_ROOT) BRANCH_PREFIX=$(BRANCH_PREFIX)
