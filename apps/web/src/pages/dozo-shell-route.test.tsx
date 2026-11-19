// @vitest-environment jsdom

import type { AppBootstrap, Bot } from "@rakazo/contracts";
import { act, useLayoutEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useMatch } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../lib/rpc";
import { useShellNavigation } from "./shell/use-shell-navigation";
import { useSpaceBootstrap, useSpaceRoster } from "./shell/use-space-roster";
import { useOpenSpaceChat } from "./shell/use-space-switch";
import type { ThreadState } from "./shell/use-thread-state";

// The billing offer under the shell's own route repair: the address a page load opens is fixed
// by the real navigation and roster hooks (`/app` becomes `/app/<chat>`), as the shell wires them.

const state = vi.hoisted(() => ({
  take: vi.fn(),
  me: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../lib/bootstrap", () => ({
  takeInitialBootstrap: state.take,
  primeSpaceBootstrap: vi.fn(),
  discardPrimedBootstrap: () => {},
}));
vi.mock("../lib/call-session", () => ({
  getSnapshot: () => null,
  isLeavingSession: () => false,
}));
vi.mock("../lib/organizations", () => ({ leaveOrganization: async () => {} }));
vi.mock("../lib/query", () => ({
  queryClient: { getQueryData: () => undefined, setQueryData: () => {} },
  spaceSeedKey: () => [],
  lastChatKey: () => [],
  seedOnLeave: () => undefined,
}));
vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => "personal",
  selectSpace: () => true,
  rpc: { me: state.me, billing: { status: state.status } },
}));
vi.mock("../lib/tts", () => ({ speaker: { stop: () => {} } }));
vi.mock("../lib/user-error", () => ({ errorText: () => "" }));
vi.mock("../lib/auth", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user-a" } } }) },
}));
vi.mock("./Shell", () => ({ ShellPage: () => <RosterShell /> }));

import { readPlanIntent, savePlanIntent } from "../lib/dozo-plan-intent";
import { ShellPage } from "./dozo-shell";

const thread = {
  snapshotRef: { current: null },
  bootstrappedThread: { current: null },
  commitSnapshot: () => {},
  setRoutines: () => {},
  setRoutinesBotId: () => {},
} as unknown as ThreadState;

function bootstrap(): AppBootstrap {
  return {
    me: { spaceId: "personal", timezone: "UTC" },
    bots: [{ id: "bot-1", spaceId: "personal" } as Bot],
    groups: [],
    botSections: [],
    archivedBots: [],
    archivedGroups: [],
    spaces: [],
    routines: [],
  } as unknown as AppBootstrap;
}

const rosterRpc = {
  spaces: {
    list: async () => {
      const { bots, groups, botSections } = bootstrap();
      return { current: { bots, groups, botSections }, spaces: [] };
    },
  },
} as unknown as ReturnType<typeof createSpaceRpc>;

/** Upstream's shell reduced to what decides its address: navigation, roster and first load. */
function RosterShell() {
  const groupId = useMatch("/app/g/:groupId")?.params.groupId;
  const botId = useMatch("/app/:botId")?.params.botId;
  const [shellSpaceId] = useState("personal");
  const { navigate, navigationRevision, overlayRevision, redirectKeepingOverlay } =
    useShellNavigation();
  const roster = useSpaceRoster({
    rpc: rosterRpc,
    seed: undefined,
    navigate,
    redirectKeepingOverlay,
  });
  const openSpaceChatRef = useRef<(spaceId: string, path: string) => void>(() => {});
  useSpaceBootstrap({
    rpc: rosterRpc,
    roster,
    thread,
    commitComputer: () => {},
    userId: "user-a",
    shellSpaceId,
    seed: undefined,
    startChat: undefined,
    botId,
    groupId,
    chat: undefined,
    navigate,
    redirectKeepingOverlay,
    openSpaceChat: openSpaceChatRef,
  });
  const openSpaceChat = useOpenSpaceChat({
    bootstrapSpaceId: roster.bootstrapMe?.spaceId,
    userId: "user-a",
    navigate,
    navigationRevision,
    overlayRevision,
    closeMobileSidebar: () => {},
    beginSpaceSwitch: roster.beginSpaceSwitch,
  });
  useLayoutEffect(() => {
    openSpaceChatRef.current = openSpaceChat;
  }, [openSpaceChat]);
  return null;
}

let root: Root;
let container: HTMLDivElement;

/** A page load at `path`, with the first load already answered, as after a return from checkout. */
async function load(path: string) {
  window.history.replaceState({ idx: 0 }, "", path);
  await act(async () =>
    root.render(
      <BrowserRouter useTransitions={false}>
        <Routes>
          <Route path="/app" element={<ShellPage />} />
          <Route path="/app/:botId" element={<ShellPage />} />
        </Routes>
      </BrowserRouter>,
    ),
  );
  await act(async () => {});
}
const address = () => window.location.pathname + window.location.search;

/**
 * A page load at `path` scheduled as a browser schedules it, outside `act`: a navigation's render
 * waits for React's scheduler, so promise callbacks already queued run first, as they do live.
 */
async function loadLive(path: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  window.history.replaceState({ idx: 0 }, "", path);
  root.render(
    <BrowserRouter useTransitions={false}>
      <Routes>
        <Route path="/app" element={<ShellPage />} />
        <Route path="/app/:botId" element={<ShellPage />} />
      </Routes>
    </BrowserRouter>,
  );
  // Settled: the address has stopped moving for a few scheduler turns.
  let last = "";
  let still = 0;
  await vi.waitUntil(() => {
    const now = address();
    still = now === last ? still + 1 : 0;
    last = now;
    return still >= 5;
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.take.mockReset().mockResolvedValue(bootstrap());
  state.me.mockReset().mockResolvedValue({ billingEnabled: true });
  state.status.mockReset().mockResolvedValue({
    canManage: true,
    funding: "byok",
    byokPriceCents: null,
    byokTier: "standard",
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

it("reopens Billing on the chat the app lands on after a checkout left unpaid", async () => {
  await load("/app?billing=canceled");
  expect(address()).toBe("/app/bot-1?settings=billing");
});

it("reopens Billing after a checkout left unpaid on a chat's own address", async () => {
  await load("/app/bot-1?billing=canceled");
  expect(address()).toBe("/app/bot-1?settings=billing");
});

it("offers a picked plan on the chat the app lands on", async () => {
  savePlanIntent({ tier: "pro", period: "year" });
  await load("/app");
  expect(address()).toBe("/app/bot-1?settings=billing");
  expect(readPlanIntent()).toEqual({ tier: "pro", period: "year" });
});

it("offers a picked plan even when the server answers before the first load", async () => {
  let loaded: (value: AppBootstrap) => void = () => {};
  state.take.mockReturnValue(new Promise((resolve) => (loaded = resolve)));
  savePlanIntent({ tier: "max", period: "month" });
  await load("/app");
  // Billing is asked for while the address is still `/app`; the repair lands afterwards.
  await act(async () => loaded(bootstrap()));
  await act(async () => {});
  expect(address()).toBe("/app/bot-1?settings=billing");
});

it("reopens Billing after a checkout left unpaid, scheduled as in a browser", async () => {
  await loadLive("/app?billing=canceled");
  expect(address()).toBe("/app/bot-1?settings=billing");
});

it("offers a picked plan on the chat the app lands on, scheduled as in a browser", async () => {
  savePlanIntent({ tier: "pro", period: "month" });
  await loadLive("/app");
  expect(address()).toBe("/app/bot-1?settings=billing");
});
