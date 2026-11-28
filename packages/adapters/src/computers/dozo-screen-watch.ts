import type { AdapterContext, SandboxProvider, ScreenSession } from "@rakazo/adapter-kit";
import type { KnownSandboxKind } from "./computer-providers.js";
import { isKnownSandboxKind } from "./computer-providers.js";
import { toComputerRef } from "./screens/computer-support.js";

/**
 * Per kind, whether a view-only screen read is pure watching: on a machine that is not running it
 * fails or answers no screen, and never starts, resumes or extends it; it never changes who
 * controls the screen; and it never mints a single-use sign-in. Every kind is declared, so a new
 * one is a type error here until someone reads its screen path. A kind declared false is shown on
 * the computers wall as its bot, never streamed.
 */
const WATCHES_WITHOUT_WAKE: Readonly<Record<KnownSandboxKind, boolean>> = {
  none: false,
  docker: true,
  wuying: false,
  e2b: false,
  novita: false,
  daytona: false,
  createos: false,
  boat: false,
  boxd: false,
  instabox: false,
  railway: false,
  kubernetes: false,
  incus: false,
  "local-vm": false,
  desktop: false,
  fake: true,
};

export function watchesScreenWithoutWake(kind: string | null | undefined): boolean {
  return isKnownSandboxKind(kind) && WATCHES_WITHOUT_WAKE[kind];
}

/**
 * The view-only screen of a computer the database says is running, for a kind that watches
 * without waking (null for any other). The reference carries no start size, the request is never
 * interactive and holds no control token.
 */
export async function watchScreen(
  sandbox: Pick<SandboxProvider, "connectScreen">,
  computer: { homeKey: string; kind: string; providerRef: string | null },
  context: AdapterContext,
): Promise<ScreenSession | null> {
  if (!watchesScreenWithoutWake(computer.kind) || !computer.providerRef) return null;
  return sandbox.connectScreen(
    toComputerRef(computer),
    { view: "stream", interactive: false },
    context,
  );
}
