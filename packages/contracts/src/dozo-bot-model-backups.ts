import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";
import { modelChoiceListSchema } from "./model-connections.js";
import { ModelRoleChoiceSchema } from "./model-roles.js";

/**
 * A bot's own ordered backup models, the same rows a member's model settings hold. Empty: the
 * bot's runs take the backups of whoever runs them. A row's connection is the saver's; a run by
 * someone else resolves that row on their own connection of the provider.
 */
export const DozoBotModelBackupsSchema = z.object({
  backups: modelChoiceListSchema(ModelRoleChoiceSchema),
});
export type DozoBotModelBackups = z.infer<typeof DozoBotModelBackupsSchema>;

export const dozoBotModelBackupsContract = /* @__PURE__ */ (() => ({
  get: oc.input(z.object({ botId: Id })).output(DozoBotModelBackupsSchema),
  set: oc.input(DozoBotModelBackupsSchema.extend({ botId: Id })).output(DozoBotModelBackupsSchema),
}))();
