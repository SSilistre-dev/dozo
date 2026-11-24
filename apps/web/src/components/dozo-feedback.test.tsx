// @vitest-environment jsdom
import type { DozoFeedbackStatus } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  send: vi.fn(),
  toast: vi.fn(),
  download: vi.fn(),
  bridge: vi.fn(),
}));

vi.mock("../lib/rpc", () => {
  const rpc = { dozoFeedback: { send: api.send } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoFeedback: {
      status: {
        queryOptions: () => ({ queryKey: ["feedback"], queryFn: () => api.status() }),
      },
    },
  }),
}));
vi.mock("../lib/desktop", () => ({ desktopBridge: api.bridge }));
vi.mock("../lib/artifact-open", () => ({ downloadArtifactBytes: api.download }));
vi.mock("../lib/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Dialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => (
    <>
      <button type="button" data-testid="dismiss" onClick={() => onOpenChange(false)} />
      {children}
    </>
  ),
  DialogContent: ({ children, ...props }: ComponentProps<"div">) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Disclosure: ({ summary, children }: { summary: ReactNode; children: ReactNode }) => (
    <details>
      <summary>{summary}</summary>
      {children}
    </details>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    id: string;
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  toast: Object.assign(api.toast, { error: vi.fn() }),
}));

import type * as Query from "../lib/query";
import { DozoFeedbackHost, DozoFeedbackItem } from "./dozo-feedback";
import { clientDiagnostics } from "./dozo-feedback-dialog";

const server = {
  revision: "abc1234",
  failedRuns: [{ id: "run-2", at: "2026-11-20T11:00:00.000Z" }],
};
const sendStatus: DozoFeedbackStatus = {
  mode: "send",
  address: null,
  from: "person@example.test",
  server,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onOpen = vi.fn();

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DozoFeedbackItem onOpen={onOpen} />
        <DozoFeedbackHost />
      </QueryClientProvider>,
    );
  });
}

const item = () =>
  [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Send feedback"),
  );
const button = (text: string) =>
  [...container.querySelectorAll("footer button")].find(
    (candidate) => candidate.textContent === text,
  ) as HTMLButtonElement | undefined;
const preview = () => container.querySelector('[data-testid="dozo-feedback-preview"]')?.textContent;

async function openDialog() {
  await render();
  await act(() => vi.waitFor(() => expect(item()).toBeDefined()));
  await act(async () => item()?.click());
  await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).not.toBeNull());
}

async function type(text: string) {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function toggleDiagnostics() {
  const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => box.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.status.mockReset().mockResolvedValue(sendStatus);
  api.send.mockReset().mockResolvedValue({ sent: true });
  api.toast.mockReset();
  api.download.mockReset();
  api.bridge.mockReset().mockReturnValue(undefined);
  onOpen.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the account menu item", () => {
  it("is not there when the server has no address for feedback", async () => {
    api.status.mockResolvedValue({ ...sendStatus, mode: null });
    await render();
    expect(item()).toBeUndefined();
  });

  it("closes the menu and opens the dialog", async () => {
    await openDialog();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(container.querySelector("h2")?.textContent).toBe("Send feedback");
  });
});

describe("closing", () => {
  it("closes on Escape or a click outside without sending", async () => {
    await openDialog();
    await type("Never mind");
    await act(async () =>
      (container.querySelector('[data-testid="dismiss"]') as HTMLButtonElement).click(),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(api.send).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  it("sends only the note while diagnostics are off, and shows that before sending", async () => {
    await openDialog();
    expect(button("Send")?.disabled).toBe(true);
    await type("The app froze.");
    expect(preview()).toBe("--\nFrom: person@example.test");
    await act(async () => button("Send")?.click());
    expect(api.send).toHaveBeenCalledWith({ message: "The app froze." });
    await vi.waitFor(() => expect(api.toast).toHaveBeenCalledWith("Sent"));
    await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
  });

  it("adds the diagnostics the preview lists, and nothing the preview does not", async () => {
    await openDialog();
    await type("Replies stopped.");
    await toggleDiagnostics();
    const shown = preview() ?? "";
    expect(shown).toBe(
      [
        "--",
        "From: person@example.test",
        "Surface: web",
        `Browser: ${navigator.userAgent}`,
        `Language: ${navigator.language}`,
        `Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        "Server revision: abc1234",
        "Failed runs: run-2 (2026-11-20T11:00:00.000Z)",
      ].join("\n"),
    );
    // The note itself is not repeated in the diagnostics.
    expect(shown).not.toContain("Replies stopped.");
    await act(async () => button("Send")?.click());
    expect(api.send).toHaveBeenCalledWith({
      message: "Replies stopped.",
      diagnostics: { client: clientDiagnostics(), runIds: ["run-2"] },
    });
  });

  it("says when it could not send and keeps the note", async () => {
    api.send.mockRejectedValue(new Error("Too many reports"));
    await openDialog();
    await type("Again");
    await act(async () => button("Send")?.click());
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not send"),
    );
    expect(container.querySelector("textarea")?.value).toBe("Again");
  });
});

describe("without mail on the server", () => {
  it("saves the report for the person to email to the address shown", async () => {
    api.status.mockResolvedValue({
      ...sendStatus,
      mode: "save",
      address: "inbox@operator.example.test",
    });
    await openDialog();
    expect(button("Send")).toBeUndefined();
    const link = container.querySelector("footer a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("mailto:inbox@operator.example.test");
    expect(button("Save")?.disabled).toBe(true);
    await type("Local server will not start.");
    await act(async () => button("Save")?.click());
    expect(api.send).not.toHaveBeenCalled();
    const [name, type_, bytes] = api.download.mock.calls[0] ?? [];
    expect([name, type_]).toEqual(["feedback.txt", "text/plain"]);
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe(
      "Local server will not start.\n\n--\nFrom: person@example.test\n",
    );
  });
});

const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const pixelUrl = `data:image/png;base64,${PIXEL}`;
const picture = (name = "shot.png", type = "image/png") =>
  new File([Uint8Array.from(atob(PIXEL), (c) => c.charCodeAt(0))], name, { type });
const fileInput = () =>
  container.querySelector<HTMLInputElement>(
    '[data-testid="dozo-feedback-file"]',
  ) as HTMLInputElement;
const thumbnails = () => container.querySelectorAll("img");
/** Waits until that many pictures are shown, letting the file reads and their renders finish. */
const shows = (count: number) =>
  vi.waitFor(async () => {
    await act(() => flush());
    expect(thumbnails()).toHaveLength(count);
  });
/** Picks the files and waits until that many pictures are shown. */
async function choose(shown: number, ...files: File[]) {
  await act(async () => {
    Object.defineProperty(fileInput(), "files", { value: files, configurable: true });
    fileInput().dispatchEvent(new Event("change", { bubbles: true }));
  });
  await shows(shown);
}
const addButton = () =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Add image");

describe("pictures", () => {
  it("adds them from the picker, shows each small with a way to remove it, and sends them", async () => {
    await openDialog();
    expect(addButton()).toBeDefined();
    await choose(2, picture(), picture("two.png"));
    expect(thumbnails()).toHaveLength(2);
    expect(preview()).toBe("--\nFrom: person@example.test\nImages: 2");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove image"]')?.click(),
    );
    expect(thumbnails()).toHaveLength(1);
    await type("Look at this");
    await act(async () => button("Send")?.click());
    expect(api.send).toHaveBeenCalledWith({ message: "Look at this", images: [pixelUrl] });
  });

  it("takes a picture pasted into the note, and leaves pasted text alone", async () => {
    await openDialog();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const paste = (files: File[]) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { files } });
      act(() => {
        textarea.dispatchEvent(event);
      });
      return event;
    };
    expect(paste([]).defaultPrevented).toBe(false);
    expect(paste([picture("image.png")]).defaultPrevented).toBe(true);
    await shows(1);
  });

  it("takes a picture dropped on the dialog", async () => {
    await openDialog();
    const dialog = container.querySelector('[data-testid="dozo-feedback"]') as HTMLElement;
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    await act(async () => {
      dialog.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [picture()] } });
    await act(async () => {
      dialog.dispatchEvent(drop);
    });
    await shows(1);
  });

  it("says so when a file is not a PNG, JPEG or WebP, and keeps the rest", async () => {
    await openDialog();
    await choose(1, picture("a.gif", "image/gif"), picture());
    expect(thumbnails()).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't use that image");
    await choose(2, picture("b.png"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("stops offering to add at three", async () => {
    await openDialog();
    await choose(3, picture("1.png"), picture("2.png"), picture("3.png"));
    expect(addButton()).toBeUndefined();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove image"]')?.click(),
    );
    expect(addButton()).toBeDefined();
  });

  it("opens the picker from the button, and ignores a picker closed with nothing", async () => {
    await openDialog();
    const click = vi.spyOn(fileInput(), "click");
    await act(async () => addButton()?.click());
    expect(click).toHaveBeenCalled();
    await choose(0);
    expect(thumbnails()).toHaveLength(0);
  });

  it("saves them next to the report when the server sends no mail", async () => {
    api.status.mockResolvedValue({
      ...sendStatus,
      mode: "save",
      address: "inbox@operator.example.test",
    });
    await openDialog();
    await choose(1, picture("shot.png"));
    await type("Local server will not start.");
    await act(async () => button("Save")?.click());
    expect(api.download).toHaveBeenCalledTimes(2);
    const [text] = api.download.mock.calls[0] ?? [];
    expect(text).toBe("feedback.txt");
    const [name, kind, bytes] = api.download.mock.calls[1] ?? [];
    expect([name, kind]).toEqual(["shot.png", "image/png"]);
    expect(new TextDecoder("latin1").decode(bytes as Uint8Array)).toContain("PNG");
  });
});

describe("clientDiagnostics", () => {
  it("names the desktop app when it hosts the page", () => {
    api.bridge.mockReturnValue({});
    expect(clientDiagnostics().surface).toBe("desktop");
  });

  it("keeps each value within the server's limits", () => {
    const view = {
      navigator: { userAgent: "u".repeat(500), language: "l".repeat(50) },
    } as unknown as Window;
    const result = clientDiagnostics(view);
    expect(result.userAgent).toHaveLength(300);
    expect(result.language).toHaveLength(35);
  });
});
