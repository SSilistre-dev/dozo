import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** A pool holds at most this many connections of one provider, the first ones added. */
export const DOZO_MODEL_POOL_MAX = 5;

/**
 * The person's connections that may hand a run over to each other when one runs out: only where
 * two or more of one provider's connections are of a kind that may join a pool. The server decides
 * which; a connection absent here offers no pool.
 */
export const DozoModelPoolSchema = z.object({
  connections: z.array(
    z.object({
      credentialId: Id,
      /** This connection hands over to, and takes over from, at least one other. */
      pooled: z.boolean(),
      /** Set while a pooled connection that ran out rests: when it opens again. */
      opensAt: IsoDate.optional(),
    }),
  ),
  /**
   * The person's models, or with modelId "" whole connections, that rest now after their quota
   * ran out or their key was refused, pooled or not, and when each opens again.
   */
  rests: z.array(z.object({ credentialId: Id, modelId: z.string(), opensAt: IsoDate })).optional(),
});
export type DozoModelPool = z.infer<typeof DozoModelPoolSchema>;

export const dozoModelPoolContract = /* @__PURE__ */ (() => ({
  get: oc.output(DozoModelPoolSchema),
  /** Pools every offered connection of this connection's provider, or none of them. */
  set: oc.input(z.object({ credentialId: Id, pooled: z.boolean() })).output(DozoModelPoolSchema),
}))();
