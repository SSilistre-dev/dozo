import { oc } from "@orpc/contract";
import * as z from "zod";

export const DozoLocalModelServerSchema = /* @__PURE__ */ (() =>
  z.object({
    name: z.string(),
    baseUrl: z.string(),
    models: z.array(z.string()),
  }))();
export type DozoLocalModelServer = z.infer<typeof DozoLocalModelServerSchema>;

export const dozoLocalModelsContract = /* @__PURE__ */ (() => ({
  /**
   * The model servers running on the server's own computer and the models each lists. `available`
   * is false where the deployment may not reach private addresses: nothing is looked for there.
   */
  servers: oc.output(
    z.object({ available: z.boolean(), servers: z.array(DozoLocalModelServerSchema) }),
  ),
}))();
