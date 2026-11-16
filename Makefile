# Dozo fork gates. Upstream has no root Makefile; this file is ours.
# Until dozo/ is committed, staging overlays the working tree (override: DOZO_STAGE_WORKTREE=).
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
