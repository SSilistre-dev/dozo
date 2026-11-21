// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ shared: [] as string[], shareFails: false }));

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("section", {}, children),
  Modal: ({
    visible,
    children,
    onRequestClose,
    presentationStyle,
  }: {
    visible: boolean;
    children?: ReactNode;
    onRequestClose: () => void;
    presentationStyle: string;
  }) =>
    visible
      ? createElement(
          "dialog",
          { open: true, "data-presentation": presentationStyle },
          createElement("button", {
            type: "button",
            "aria-label": "Request close",
            onClick: onRequestClose,
          }),
          children,
        )
      : null,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("main", {}, children),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: (props: {
    accessibilityLabel: string;
    icon: { ios: string; android: string };
    onPress: () => void;
  }) =>
    createElement("button", {
      type: "button",
      "aria-label": props.accessibilityLabel,
      "data-icon": `${props.icon.ios}|${props.icon.android}`,
      onClick: props.onPress,
    }),
}));
vi.mock("../lib/dozo-table-share", () => ({
  shareCsv: async (csv: string) => {
    host.shared.push(csv);
    if (host.shareFails) throw new Error("no sharing");
  },
}));
vi.mock("@rakazo/chat-ui/native", () => ({
  useMarkdownCopy: () => ({
    downloadCsv: "Download CSV",
    expandTable: "Expand table",
    closeTable: "Close table",
  }),
}));

import { TableTools } from "../components/dozo-table-tools";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const containers: HTMLElement[] = [];
function show() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  act(() =>
    createRoot(container).render(
      <TableTools csv={"a,b\n1,2"} renderTable={() => createElement("div", {}, "the table")} />,
    ),
  );
  return container;
}
const button = (page: HTMLElement, label: string) =>
  page.querySelector<HTMLElement>(`button[aria-label="${label}"]`);

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
  host.shared.length = 0;
  host.shareFails = false;
});

it("shares the table as CSV from the share control", async () => {
  const page = show();
  expect(button(page, "Download CSV")?.getAttribute("data-icon")).toBe(
    "square.and.arrow.up|share-outline",
  );
  await act(async () => button(page, "Download CSV")?.click());
  expect(host.shared).toEqual(["a,b\n1,2"]);
});

it("does not fail a press when sharing fails", async () => {
  host.shareFails = true;
  const page = show();
  await act(async () => button(page, "Download CSV")?.click());
  expect(host.shared).toHaveLength(1);
  expect(page.querySelector("dialog")).toBeNull();
});

it("opens the table full screen and closes it again", () => {
  const page = show();
  expect(page.querySelector("dialog")).toBeNull();
  act(() => button(page, "Expand table")?.click());
  const dialog = page.querySelector("dialog");
  expect(dialog?.getAttribute("data-presentation")).toBe("fullScreen");
  expect(dialog?.textContent).toBe("the table");
  act(() => button(page, "Close table")?.click());
  expect(page.querySelector("dialog")).toBeNull();
  act(() => button(page, "Expand table")?.click());
  act(() => button(page, "Request close")?.click());
  expect(page.querySelector("dialog")).toBeNull();
});
