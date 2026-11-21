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
  /** Another account may still be added. */
  canAdd: z.boolean(),
  /** Another account's sign-in in progress, with the address the tool printed, or why it ended. */
  login: z
    .object({
      status: z.enum(["waiting", "failed"]),
      url: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
});
export type DozoCliTool = z.infer<typeof DozoCliToolSchema>;

const DozoCliToolsSchema = z.object({ tools: z.array(DozoCliToolSchema) });
const Provider = z.object({ provider: z.string().min(1).max(100) });

export const dozoCliAccountsContract = {
  /** Empty unless the server runs on the person's own computer and serves only them. */
  list: oc.output(DozoCliToolsSchema),
  /** Connects the tool's own sign-in on this computer as a model connection. */
  connect: oc.input(Provider).output(DozoCliToolsSchema),
  /** Starts the tool's own sign-in of another account, in a home of its own. */
  addAccount: oc.input(Provider).output(DozoCliToolsSchema),
  /** Hands a code the tool's sign-in asks for to it. */
  sendCode: oc
    .input(Provider.extend({ code: z.string().min(1).max(512) }))
    .output(DozoCliToolsSchema),
  /** Ends a sign-in in progress, or clears one that did not finish. */
  cancelLogin: oc.input(Provider).output(DozoCliToolsSchema),
};
