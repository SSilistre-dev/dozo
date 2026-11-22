import { oc } from "@orpc/contract";
import * as z from "zod";

/** A provider's command-line tool on the server's own computer, as settings show it. */
export const DozoCliToolSchema = /* @__PURE__ */ (() =>
  z.object({
    provider: z.string(),
    name: z.string(),
    /** A model the bot talks through, or an agent that runs the bot's whole turn as the person. */
    mode: z.enum(["model", "agent"]),
    /** Installed where the server runs. */
    found: z.boolean(),
    /** The person's own sign-in is there; null when the tool would not say. */
    signedIn: z.boolean().nullable(),
    /** A connection already uses the person's own sign-in. */
    connected: z.boolean(),
    /** Another account may still be added. */
    canAdd: z.boolean(),
    /** An agent whose maker's terms count this use as a reason to close the account. */
    termsRisk: z.boolean().optional(),
    /** Another account's sign-in in progress, with the address the tool printed, or why it ended. */
    login: z
      .object({
        status: z.enum(["waiting", "failed"]),
        url: z.string().optional(),
        error: z.string().optional(),
      })
      .optional(),
  }))();
export type DozoCliTool = z.infer<typeof DozoCliToolSchema>;

const DozoCliToolsSchema = /* @__PURE__ */ (() =>
  z.object({ tools: z.array(DozoCliToolSchema) }))();
const Provider = /* @__PURE__ */ (() => z.object({ provider: z.string().min(1).max(100) }))();

export const dozoCliAccountsContract = /* @__PURE__ */ (() => ({
  /** Empty unless the server runs on the person's own computer and serves only them. */
  list: oc.output(DozoCliToolsSchema),
  /**
   * Connects the tool's own sign-in on this computer. An agent needs `consent`: the person agreed
   * to what agent mode means.
   */
  connect: oc
    .input(
      Provider.extend({ consent: z.boolean().optional(), termsConsent: z.boolean().optional() }),
    )
    .output(DozoCliToolsSchema),
  /** Starts the tool's own sign-in of another account, in a home of its own. */
  addAccount: oc.input(Provider).output(DozoCliToolsSchema),
  /** Hands a code the tool's sign-in asks for to it. */
  sendCode: oc
    .input(Provider.extend({ code: z.string().min(1).max(512) }))
    .output(DozoCliToolsSchema),
  /** Ends a sign-in in progress, or clears one that did not finish. */
  cancelLogin: oc.input(Provider).output(DozoCliToolsSchema),
}))();
