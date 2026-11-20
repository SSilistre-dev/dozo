import { oc } from "@orpc/contract";
import * as z from "zod";

/** A provider's command-line tool on the server's own computer, as settings show it. */
export const DozoCliToolSchema = z.object({
  provider: z.string(),
  name: z.string(),
  /** Installed where the server runs. */
  found: z.boolean(),
  /** The person's own sign-in is there; null when the tool would not say. */
  signedIn: z.boolean().nullable(),
  /** A connection already uses the person's own sign-in. */
  connected: z.boolean(),
});
export type DozoCliTool = z.infer<typeof DozoCliToolSchema>;

const DozoCliToolsSchema = z.object({ tools: z.array(DozoCliToolSchema) });

export const dozoCliAccountsContract = {
  /** Empty unless the server runs on the person's own computer and serves only them. */
  list: oc.output(DozoCliToolsSchema),
  /** Connects the tool's own sign-in on this computer as a model connection. */
  connect: oc.input(z.object({ provider: z.string().min(1).max(100) })).output(DozoCliToolsSchema),
};
