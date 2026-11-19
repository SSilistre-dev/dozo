// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { WebViewProps } from "react-native-webview";
import type * as Shared from "react-native-webview/lib/WebViewShared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MermaidDiagram } from "../components/mermaid-diagram";
import { SandboxedHtmlPreview } from "../components/sandboxed-html-preview";

// Runs on the branded tree (`make qa`): the navigation rules of the bot-HTML preview and the chat
// diagram live in dozo/brand/brand.json.
// The WebView stand-in hands every navigation to the library's own request check, as the iOS and
// Android views do, so the test sees what the device would do with each URL.

const linking = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => true),
}));
const webview = vi.hoisted(() => ({
  navigate: (_url: string): boolean => {
    throw new Error("no WebView rendered");
  },
}));

vi.mock("react-native", () => ({
  Linking: linking,
  Platform: { OS: "ios" },
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ActivityIndicator: () => <div role="progressbar" />,
}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://one.example.invalid",
  subscribeApiBase: () => () => {},
}));
vi.mock("react-native-webview", async () => {
  const shared = await vi.importActual<typeof Shared>("react-native-webview/src/WebViewShared");
  return {
    WebView: (props: Pick<WebViewProps, "originWhitelist" | "onShouldStartLoadWithRequest">) => {
      webview.navigate = (url) => {
        let started: boolean | undefined;
        const check = shared.createOnShouldStartLoadWithRequest(
          (shouldStart) => {
            started = shouldStart;
          },
          props.originWhitelist ?? shared.defaultOriginWhitelist,
          props.onShouldStartLoadWithRequest,
        );
        check({ nativeEvent: { url, lockIdentifier: 1 } } as never);
        if (started === undefined) throw new Error("the request was never answered");
        return started;
      };
      return <div data-webview />;
    },
  };
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  linking.canOpenURL.mockClear();
  linking.openURL.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (appShell: boolean) =>
  act(async () => root.render(<SandboxedHtmlPreview html="<p>hi</p>" appShell={appShell} />));

it.each([false, true])(
  "keeps an app link or another app's scheme inside the preview (app shell: %s)",
  async (appShell) => {
    await render(appShell);
    for (const url of ["rakazo://server", "tel:1", "sms:1", "https://example.com/"]) {
      expect(webview.navigate(url), url).toBe(false);
    }
    await flush();
    expect(linking.canOpenURL).not.toHaveBeenCalled();
    expect(linking.openURL).not.toHaveBeenCalled();
  },
);

it("still loads the preview document itself", async () => {
  await render(false);
  expect(webview.navigate("about:blank")).toBe(true);
  expect(webview.navigate("about:srcdoc")).toBe(false);
});

it("still loads the app shell and its srcdoc frame", async () => {
  await render(true);
  expect(webview.navigate("about:blank")).toBe(true);
  expect(webview.navigate("about:srcdoc")).toBe(true);
});

it("keeps an app link or another app's scheme inside a chat diagram", async () => {
  await act(async () =>
    root.render(
      <MermaidDiagram
        source="graph TD; A-->B"
        palette={tokensForAppearance("dark")}
        colorScheme="dark"
        fallback={null}
      />,
    ),
  );
  expect(webview.navigate("about:blank")).toBe(true);
  for (const url of ["rakazo://server", "tel:1", "https://example.com/"]) {
    expect(webview.navigate(url), url).toBe(false);
  }
  await flush();
  expect(linking.canOpenURL).not.toHaveBeenCalled();
  expect(linking.openURL).not.toHaveBeenCalled();
});
