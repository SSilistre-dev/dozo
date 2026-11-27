// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./dozo-result", () => ({
  CallbackResult: () => <p>callback</p>,
  PageUnavailable: () => <p>unavailable</p>,
  SlackInstallFailed: () => <p>slack</p>,
  McpOAuthResult: ({ error }: { error: string | null }) => <p>oauth {error}</p>,
}));

import {
  DozoCallbackResult,
  DozoMcpOAuthResult,
  DozoPageUnavailable,
  DozoSlackInstallFailed,
} from "./dozo-result-lazy";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("loads each result page on demand and passes its props through", async () => {
  await act(async () => root.render(<DozoCallbackResult />));
  await vi.waitFor(() => expect(container.textContent).toBe("callback"));
  await act(async () => root.render(<DozoPageUnavailable />));
  await vi.waitFor(() => expect(container.textContent).toBe("unavailable"));
  await act(async () => root.render(<DozoSlackInstallFailed />));
  await vi.waitFor(() => expect(container.textContent).toBe("slack"));
  await act(async () => root.render(<DozoMcpOAuthResult error="denied" done={false} />));
  await vi.waitFor(() => expect(container.textContent).toBe("oauth denied"));
});
