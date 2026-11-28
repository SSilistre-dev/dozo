// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  publish: vi.fn(),
  revoke: vi.fn(),
  copy: vi.fn(async () => true),
  toastError: vi.fn(),
}));

vi.mock("../../lib/query/rpc", () => {
  const rpc = { dozoReplays: { publish: api.publish }, dozoShareLinks: { revoke: api.revoke } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoReplays: {
      preview: {
        key: ({ input }: { input: { messageId: string } }) => [
          ["dozoReplays", "preview"],
          input.messageId,
        ],
        queryOptions: ({ input }: { input: { messageId: string } }) => ({
          queryKey: [["dozoReplays", "preview"], input.messageId],
          queryFn: () => api.preview(input),
        }),
      },
    },
  }),
}));
vi.mock("../../lib/dozo-error-text", () => ({
  errorText: (error: unknown) => (error instanceof Error ? error.message : "failed"),
  toastError: api.toastError,
}));
vi.mock("../../components/PageLoading", () => ({ PageLoading: () => <p>loading</p> }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { date: (date: Date) => date.toISOString().slice(0, 10) },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _v,
      size: _s,
      ...props
    }: ComponentProps<"button"> & Record<string, string>) => <button type="button" {...props} />,
    Checkbox: ({
      checked,
      onCheckedChange,
    }: {
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
    }) => (
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheckedChange(e.target.checked)}
      />
    ),
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    useCopyText: () => [false, api.copy],
  };
});

import type * as Query from "../../lib/query/query";
import { DozoReplaySurface, startingChoice } from "./dozo-replay-surface";

const steps = [
  {
    line: "Browser navigate · shop.example.test",
    frame: "data:image/png;base64,AA==",
    sensitive: false,
  },
  { line: "Browser act", frame: null, sensitive: true },
  { line: "Screenshot", frame: "data:image/png;base64,BB==", sensitive: true },
];
const link = {
  id: "l-1",
  kind: "replay",
  targetId: "r-1",
  createdAt: "2026-11-20T10:00:00.000Z",
  expiresAt: "2026-11-27T10:00:00.000Z",
  revokedAt: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <DozoReplaySurface params={{ messageId: "m-1" }} onClose={() => undefined} />
      </QueryClientProvider>,
    );
  });
}
const boxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === text);
const click = (node: Element | null | undefined) =>
  act(async () => {
    if (!node) throw new Error("Missing control");
    (node as HTMLElement).click();
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const mock of Object.values(api)) mock.mockClear();
  api.preview.mockReset();
  api.publish.mockReset();
  api.revoke.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps every step and leaves out each screenshot from a sensitive step on", () => {
  const choice = startingChoice(steps);
  expect([...choice.omit]).toEqual([]);
  expect([...choice.frames]).toEqual([0]);
});

it("shows every step and screenshot, then publishes what stays checked and copies the link", async () => {
  api.preview.mockResolvedValue({ steps, links: [] });
  api.publish.mockResolvedValue({ link, url: "https://app.example.test/s/token" });
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Browser act"));
  expect(container.querySelectorAll("img")).toHaveLength(2);
  // Steps 0, 1, 2 and the two screenshots: leave out step 1, swap which screenshot goes.
  const [first, firstShot, second, third, thirdShot] = boxes();
  expect([first, firstShot, second, third, thirdShot].map((box) => box?.checked)).toEqual([
    true,
    true,
    true,
    true,
    false,
  ]);
  await click(second);
  await click(second);
  await click(second);
  await click(firstShot);
  await click(thirdShot);
  await click(button("Create link"));
  expect(api.publish).toHaveBeenCalledWith({ messageId: "m-1", omit: [1], frames: [2] });
  await vi.waitFor(() =>
    expect(container.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe(
      "https://app.example.test/s/token",
    ),
  );
  expect(api.copy).toHaveBeenCalledWith("https://app.example.test/s/token");
  api.copy.mockClear();
  await click(container.querySelector('button[aria-label="Copy"]'));
  expect(api.copy).toHaveBeenCalledWith("https://app.example.test/s/token");
  await act(async () => container.querySelector<HTMLInputElement>("input[readonly]")!.focus());
});

it("never sends the screenshot of a step it leaves out, and sends nothing with no step kept", async () => {
  api.preview.mockResolvedValue({ steps: [steps[0]!], links: [] });
  await render();
  await vi.waitFor(() => expect(boxes()).toHaveLength(2));
  await click(boxes()[0]);
  expect(container.querySelector("img")).toBeNull();
  expect(button("Create link")?.hasAttribute("disabled")).toBe(true);
});

it("lists the reply's live links and revokes one", async () => {
  api.preview.mockResolvedValue({ steps, links: [link] });
  const revoked = deferred<{ revoked: true }>();
  api.revoke.mockReturnValue(revoked.promise);
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Expires 2026-11-27"));
  await click(button("Revoke"));
  expect(api.revoke).toHaveBeenCalledWith({ id: "l-1" });
  expect(button("Revoke")?.hasAttribute("disabled")).toBe(true);
  api.preview.mockResolvedValue({ steps, links: [] });
  await act(async () => revoked.resolve({ revoked: true }));
  await vi.waitFor(() => expect(button("Revoke")).toBeUndefined());
});

it("says why a reply cannot be shared", async () => {
  api.preview.mockRejectedValue(new Error("Only a finished reply can be shared"));
  await render();
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Only a finished reply can be shared",
    ),
  );
});

it("says so when a revoke fails", async () => {
  api.preview.mockResolvedValue({ steps, links: [link] });
  api.revoke.mockRejectedValue(new Error("No"));
  await render();
  await vi.waitFor(() => expect(button("Revoke")).toBeDefined());
  await click(button("Revoke"));
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("No"));
});

it("shows why a publish failed", async () => {
  api.preview.mockResolvedValue({ steps, links: [] });
  api.publish.mockRejectedValue(new Error("Too many links"));
  await render();
  await vi.waitFor(() => expect(button("Create link")).toBeDefined());
  await click(button("Create link"));
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Too many links"),
  );
});
