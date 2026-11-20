// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  markdown: vi.fn(),
  write: vi.fn(),
  toast: vi.fn(),
  toastError: vi.fn(),
  download: vi.fn(),
  setRange: undefined as undefined | ((value: string) => void),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ContextMenuSub: Pass,
    ContextMenuSubTrigger: Pass,
    ContextMenuSubContent: Pass,
    ContextMenuSeparator: () => <hr />,
    ContextMenuItem: ({ children, onClick }: { children?: ReactNode; onClick: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    ContextMenuRadioGroup: ({
      children,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      value: string;
      onValueChange: (value: string) => void;
    }) => {
      api.setRange = onValueChange;
      return <div data-value={value}>{children}</div>;
    },
    ContextMenuRadioItem: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    toast: api.toast,
    writeClipboard: api.write,
  };
});
vi.mock("../../lib/artifact-open", () => ({ downloadArtifactBytes: api.download }));
vi.mock("../../lib/dozo-error-text", () => ({ toastError: api.toastError }));

import type { DozoChatExportMenuProps } from "./dozo-chat-export-menu";
import { chatExportFilename, chatExportSince, DozoChatExportMenu } from "./dozo-chat-export-menu";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const close = vi.fn();

async function render(target: DozoChatExportMenuProps["target"] = { botId: "bot-1" }) {
  const rpc = { dozoChatExport: { markdown: api.markdown } };
  await act(async () => {
    root.render(
      <DozoChatExportMenu
        rpc={rpc as unknown as DozoChatExportMenuProps["rpc"]}
        target={target}
        name="Ada Bot"
        onClose={close}
      />,
    );
  });
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("chatExportSince", () => {
  const now = new Date(2026, 10, 20, 15, 30);
  it("covers the whole chat, the reader's day, or the last 7 or 30 days", () => {
    expect(chatExportSince("all", now)).toBeUndefined();
    expect(chatExportSince("today", now)).toBe(new Date(2026, 10, 20).toISOString());
    expect(chatExportSince("week", now)).toBe(new Date(2026, 10, 13, 15, 30).toISOString());
    expect(chatExportSince("month", now)).toBe(new Date(2026, 9, 21, 15, 30).toISOString());
  });
});

describe("chatExportFilename", () => {
  it("takes out what file systems refuse and keeps the date", () => {
    const now = new Date("2026-11-20T12:00:00.000Z");
    expect(chatExportFilename(' Ada / "Bot" ', now)).toBe("Ada-Bot-2026-11-20.md");
    expect(chatExportFilename("  ", now)).toBe("chat-2026-11-20.md");
  });
});

describe("DozoChatExportMenu", () => {
  it("copies the whole chat as the server renders it", async () => {
    api.markdown.mockResolvedValueOnce({ markdown: "# Ada\n", truncated: false });
    api.write.mockResolvedValueOnce(true);
    await render();
    await act(async () => button("Copy as Markdown").click());
    expect(close).toHaveBeenCalled();
    expect(api.markdown).toHaveBeenCalledWith({
      botId: "bot-1",
      since: undefined,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    await vi.waitFor(() => expect(api.toast).toHaveBeenCalledWith("Copied"));
    expect(api.write).toHaveBeenCalledWith("# Ada\n");
    expect(api.download).not.toHaveBeenCalled();
  });

  it("downloads the picked range of a group chat and says when earlier messages were cut", async () => {
    api.markdown.mockResolvedValueOnce({ markdown: "# Kitchen\n", truncated: true });
    await render({ groupId: "group-1" });
    await act(async () => api.setRange?.("week"));
    await act(async () => button("Download Markdown").click());
    await vi.waitFor(() =>
      expect(api.toast).toHaveBeenCalledWith("Earlier messages were left out"),
    );
    const input = api.markdown.mock.calls[0]![0] as { groupId: string; since: string };
    expect(input.groupId).toBe("group-1");
    expect(Date.now() - new Date(input.since).getTime()).toBeGreaterThan(6.9 * 86_400_000);
    const [name, type, bytes] = api.download.mock.calls[0]!;
    expect(name).toMatch(/^Ada-Bot-\d{4}-\d{2}-\d{2}\.md$/);
    expect(type).toBe("text/markdown");
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("# Kitchen\n");
    expect(api.write).not.toHaveBeenCalled();
  });

  it("says so when the copy fails", async () => {
    api.markdown.mockResolvedValueOnce({ markdown: "# Ada\n", truncated: false });
    api.write.mockResolvedValueOnce(false);
    await render();
    await act(async () => button("Copy as Markdown").click());
    await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Could not copy"));
    expect(api.toast).not.toHaveBeenCalled();
  });

  it("says so when the server refuses", async () => {
    const refused = new Error("Not found");
    api.markdown.mockRejectedValueOnce(refused);
    await render();
    await act(async () => button("Download Markdown").click());
    await vi.waitFor(() =>
      expect(api.toastError).toHaveBeenCalledWith("Could not export", refused),
    );
    expect(api.download).not.toHaveBeenCalled();
  });
});
