import { resolveLoginFill } from "./bot-secrets.js";
import type { ResolveCodeFill, ResolveSecretFill } from "./browser/browser-tools.js";
import type { DeviceBrowserProvider } from "./dozo-device-browser.js";
import type { RunContext } from "./runs/assembly/run-context.js";
import { recordVaultUse } from "./runs/assembly/run-context.js";
import type { ToolCall } from "./runs/tools/run-tool-gate.js";
import { LOGIN_CODE_FIELD, vaultLoginUseOf } from "./secrets/vault/vault-card-use.js";

/**
 * What `browser_act` fill_secret and fill_code do in the user's own browser: a login linked to this
 * computer's password manager (dozo-device-login.ts) is filled by the computer itself. Everything
 * the vault checks before it fills on the bot's own computer is checked here by the same function
 * (`resolveLoginFill`): the site, the login's policy and the user's approval of this call. What
 * comes back is a handle, not a value, so the step carries a key of the browser (planFill) that it
 * turns into a request to the computer: nothing here ever holds, logs or hides a value.
 */
export function deviceFillOptions(
  ctx: RunContext,
  call: ToolCall,
  deviceId: string,
  browser: DeviceBrowserProvider,
): { resolveSecretFill: ResolveSecretFill; resolveCodeFill: ResolveCodeFill } {
  const resolve = async (name: string, field: string, code: boolean) => {
    const resolved = await resolveLoginFill({
      prisma: ctx.deps.prisma,
      secretStore: ctx.deps.secretStore,
      scope: ctx.run,
      runId: ctx.run.id,
      name,
      field,
      ...(code ? { code: true as const } : {}),
      approval: vaultLoginUseOf(call.args.loginApproval),
      pageUrl: ctx.state.pageUrl,
      deviceId,
    });
    if ("error" in resolved) return resolved;
    const { used, deviceLogin } = resolved;
    // Only a linked login of this computer is answered with a handle; the rest was refused above.
    if (!used || !deviceLogin) return { error: "Saved logins are unavailable here." };
    return {
      text: browser.planFill(deviceLogin),
      origin: resolved.origin,
      hidden: resolved.hidden,
      // Once the page was asked, as for any login: one use of the item on that site.
      typed: () => recordVaultUse(ctx, call.name, used, resolved.origin),
    };
  };
  return {
    resolveSecretFill: (step) => resolve(step.secret, step.field, false),
    resolveCodeFill: async (step) => {
      // A code the person typed into the chat for this run is held by the server: not here.
      if (!step.secret) return { error: "Codes are unavailable here." };
      const resolved = await resolve(step.secret, LOGIN_CODE_FIELD, true);
      if ("error" in resolved) return resolved;
      return {
        ...resolved,
        // Nothing to take or give back: the code is read on the computer, once, by the fill.
        claim: async () => undefined,
        restore: async () => {},
      };
    },
  };
}
