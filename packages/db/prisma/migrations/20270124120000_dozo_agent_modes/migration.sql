-- Additive: the previous release never reads this table. It belongs to the fork: no model in
-- schema.prisma; packages/adapters/src/cli-models/dozo-agent-modes.ts reads and writes it with SQL.
-- The agents (a provider's own CLI running a bot's whole turn) the owner of a server on their own
-- computer has turned on, one row each; no row is off. Only a provider id: never a path or a
-- command line. Not tenant data, so no row-level policy applies.
CREATE TABLE "dozo_agent_modes" (
  "provider" TEXT NOT NULL PRIMARY KEY,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
