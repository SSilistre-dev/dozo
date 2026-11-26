// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));

vi.mock("../lib/query/rpc", () => {
  const rpc = { dozoOrganizationLogo: { set: api.set } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoOrganizationLogo: {
      key: () => [["dozoOrganizationLogo"]],
      get: {
        queryOptions: ({ input }: { input: { organizationId: string } }) => ({
          queryKey: [["dozoOrganizationLogo", "get"], input.organizationId],
          queryFn: () => api.get(input),
        }),
      },
    },
  }),
}));
vi.mock("../../../../packages/i18n/src/user-error", () => ({
  errorText: (error: unknown) => (error instanceof Error ? error.message : "failed"),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(" "),
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & Record<string, string>) => <button type="button" {...props} />,
}));

import type * as Query from "../lib/query/query";
import { DozoOrganizationLogoRow, readLogoFile } from "./dozo-organization-logo-row";

const LOGO = "data:image/webp;base64,UklGRg==";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <DozoOrganizationLogoRow organizationId="org-1" />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith({ organizationId: "org-1" }));
}

const buttons = () => [...container.querySelectorAll("button")].map((node) => node.textContent);
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === name);

async function choose(file: File | undefined) {
  const input = container.querySelector<HTMLInputElement>('[data-testid="organization-logo-file"]');
  if (!input) throw new Error("No file input");
  Object.defineProperty(input, "files", { value: file ? [file] : [], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const png = (size = 8) => new File([new Uint8Array(size)], "logo.png", { type: "image/png" });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockReset();
  api.set.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("is not there for a member when the organization has no logo", async () => {
  api.get.mockResolvedValue({ logo: null, canManage: false });
  await render();
  expect(container.textContent).toBe("");
});

it("only shows the logo to a member who cannot change it", async () => {
  api.get.mockResolvedValue({ logo: LOGO, canManage: false });
  await render();
  await vi.waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(LOGO));
  expect(buttons()).toEqual([]);
  expect(container.querySelector('input[type="file"]')).toBeNull();
});

it("lets the owner upload a picture, which goes to the server as it was chosen", async () => {
  api.get.mockResolvedValue({ logo: null, canManage: true });
  api.set.mockResolvedValue({ logo: LOGO, canManage: true });
  await render();
  await vi.waitFor(() => expect(buttons()).toEqual(["Upload"]));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input?.accept).toBe("image/png,image/jpeg,image/webp,image/gif");
  api.get.mockResolvedValue({ logo: LOGO, canManage: true });
  await choose(png());
  await vi.waitFor(() =>
    expect(api.set).toHaveBeenCalledWith({
      organizationId: "org-1",
      logo: expect.stringMatching(/^data:image\/png;base64,/),
    }),
  );
  await vi.waitFor(() => expect(buttons()).toEqual(["Upload", "Remove"]));
  expect(container.querySelector("img")?.getAttribute("src")).toBe(LOGO);
});

it("removes the logo", async () => {
  api.get.mockResolvedValue({ logo: LOGO, canManage: true });
  api.set.mockResolvedValue({ logo: null, canManage: true });
  await render();
  await vi.waitFor(() => expect(button("Remove")).toBeTruthy());
  await act(async () => button("Remove")!.click());
  expect(api.set).toHaveBeenCalledWith({ organizationId: "org-1", logo: null });
});

it("says so when a file cannot be a logo, and never sends it", async () => {
  api.get.mockResolvedValue({ logo: null, canManage: true });
  await render();
  await vi.waitFor(() => expect(button("Upload")).toBeTruthy());
  // Closing the picker without a file changes nothing.
  await choose(undefined);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await choose(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }));
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't use that image as a logo",
    ),
  );
  expect(api.set).not.toHaveBeenCalled();
});

it("shows the server's refusal", async () => {
  api.get.mockResolvedValue({ logo: null, canManage: true });
  api.set.mockRejectedValue(new Error("Couldn't use that image as a logo (server)"));
  await render();
  await vi.waitFor(() => expect(button("Upload")).toBeTruthy());
  await choose(png());
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't use that image as a logo (server)",
    ),
  );
});

it("reads only the kinds of picture the server takes, within the upload limit", async () => {
  expect(await readLogoFile(new File(["x"], "a.svg", { type: "image/svg+xml" }))).toBeNull();
  expect(await readLogoFile(png(4))).toMatch(/^data:image\/png;base64,/);
  expect(await readLogoFile(png(2_200_000))).toBeNull();
  const failing = png(4);
  const original = FileReader.prototype.readAsDataURL;
  FileReader.prototype.readAsDataURL = function (this: FileReader) {
    queueMicrotask(() => this.onerror?.(new ProgressEvent("error") as never));
  };
  try {
    expect(await readLogoFile(failing)).toBeNull();
  } finally {
    FileReader.prototype.readAsDataURL = original;
  }
});
