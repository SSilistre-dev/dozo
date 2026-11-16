# Dozo fork gates. Upstream has no root Makefile; this file is ours.
# Staging overlays the uncommitted and untracked working tree on HEAD (override: DOZO_STAGE_WORKTREE=).
# So a local `make qa` can pass where CI, which stages HEAD only, fails: commit before trusting it.
export DOZO_STAGE_WORKTREE ?= 1
.PHONY: olc qa up down stage
olc:
	@dozo/docker/gate.sh olc
qa:
	@dozo/docker/gate.sh qa
stage:
	@dozo/docker/build.sh stage
up:
	@dozo/docker/build.sh all
down:
	@dozo/docker/build.sh down
.PHONY: e2e
# Dozo's own end-to-end suite against the running stack (make up first). Exit 0 pass, 2 failure.
e2e:
	@dozo/e2e/run.sh
