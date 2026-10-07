# agent-kit: one git worktree per agent session.
#
# Use it from a project's Makefile (anywhere; it does not change the default goal):
#     WORKTREE_ROOT := <your worktree root, e.g. ~/dev/acme-wt>
#     BRANCH_PREFIX := <your branch prefix, e.g. task/>
#     include scripts/worktree.mk
# or directly:  make -f scripts/worktree.mk worktree M=T-12-ledger BRANCH_PREFIX=task/
#
#   make worktree M=<name>      new worktree at $(WORKTREE_ROOT)/<name> on branch $(BRANCH_PREFIX)<name>,
#                               from BASE (default: the current HEAD of the main checkout)
#   make worktree-rm M=<name>   remove that worktree (keeps the branch; refuses if it has changes)
#   make worktree-list          list every worktree
#
# The founder runs these from the main checkout. Agents never create worktrees from a
# linked shell (AGENTS.md §12.1, CLAUDE.md), and nobody runs `git worktree prune` there.

# Default: a sibling folder named <repo>-wt, e.g. ~/dev/acme -> ~/dev/acme-wt
WORKTREE_ROOT ?= $(abspath $(CURDIR)/../$(notdir $(CURDIR))-wt)
# Make does not expand a leading ~ inside quoted recipe arguments: expand it here.
override WORKTREE_ROOT := $(patsubst ~/%,$(HOME)/%,$(patsubst ~,$(HOME),$(WORKTREE_ROOT)))
# No default prefix: every project names its own (module/, task/, ...).
BRANCH_PREFIX ?=
BASE ?= HEAD

# Keep the including Makefile's default goal.
_KIT_SAVED_GOAL := $(.DEFAULT_GOAL)

.PHONY: worktree worktree-rm worktree-list

worktree:
	@test -n "$(M)" || { echo "usage: make worktree M=<name>" >&2; exit 2; }
	@test -n "$(BRANCH_PREFIX)" || { echo "worktree: set BRANCH_PREFIX (e.g. task/) in the Makefile or on the command line" >&2; exit 2; }
	@case "$(M)" in */*|.*|*" "*) echo "worktree: M must be a plain name (no '/', no leading '.', no spaces)" >&2; exit 2;; esac
	@test ! -e "$(WORKTREE_ROOT)/$(M)" || { echo "worktree: $(WORKTREE_ROOT)/$(M) already exists" >&2; exit 1; }
	@if git show-ref --verify --quiet "refs/heads/$(BRANCH_PREFIX)$(M)"; then \
		echo "worktree: branch $(BRANCH_PREFIX)$(M) exists; checking it out"; \
		git worktree add "$(WORKTREE_ROOT)/$(M)" "$(BRANCH_PREFIX)$(M)"; \
	else \
		git worktree add "$(WORKTREE_ROOT)/$(M)" -b "$(BRANCH_PREFIX)$(M)" "$(BASE)"; \
	fi
	@echo ""
	@echo "Worktree ready: $(WORKTREE_ROOT)/$(M)  (branch $(BRANCH_PREFIX)$(M))"
	@echo "Start the agent WITH THAT DIRECTORY AS ITS WORKING DIRECTORY."

worktree-rm:
	@test -n "$(M)" || { echo "usage: make worktree-rm M=<name>" >&2; exit 2; }
	@test -n "$(BRANCH_PREFIX)" || { echo "worktree-rm: set BRANCH_PREFIX" >&2; exit 2; }
	git worktree remove "$(WORKTREE_ROOT)/$(M)"
	@echo "Removed $(WORKTREE_ROOT)/$(M); branch $(BRANCH_PREFIX)$(M) is kept."

worktree-list:
	@git worktree list

# Restore the default goal (empty when included first, so make picks the next target).
.DEFAULT_GOAL := $(_KIT_SAVED_GOAL)
