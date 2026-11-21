// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import type { SealedKdf } from "@rakazo/core";
import { SEALED_ACCOUNT_FILE_MAX_BYTES } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The smallest cost the reader accepts, to keep the tests fast.
const KDF: SealedKdf = { logN: 15, r: 8, p: 1 };
const PASSWORD = "correct horse battery";
const ZIP = new Uint8Array(70 * 1024).map((_, index) => (index * 7) % 251);

const api = vi.hoisted(() => ({
  token: vi.fn(),
  confirmed: vi.fn(),
  recheck: vi.fn(),
  fetch: vi.fn(),
  onImported: vi.fn(),
}));

vi.mock("../lib/rpc", () => {
  const rpc = { export: { accountToken: api.token } };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
    recheckSessionOnUnauthorized: api.recheck,
  };
});
vi.mock("./ConfirmIdentityDialog", () => ({
  useIdentityConfirmation: () => ({
    withIdentityConfirmation: <T,>(action: () => Promise<T>) => {
      api.confirmed();
      return action();
    },
    identityDialog: null,
  }),
}));
vi.mock("./dozo-sealed-backup-codec", async (importOriginal) => {
  const codec = await importOriginal<typeof Codec>();
  return {
    ...codec,
    sealAccountExport: (zip: Blob, password: string) => codec.sealAccountExport(zip, password, KDF),
  };
});
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
vi.mock("./ai/primitives", () => ({
  SuccessPop: ({ label }: { label: string }) => <span data-testid="success">{label}</span>,
}));
vi.mock("./SettingsRows", () => ({
  SettingsRow: ({
    label,
    control,
    children,
  }: {
    label: ReactNode;
    control: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <span>{label}</span>
      {control}
      {children}
    </div>
  ),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Spinner: () => <span />,
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        <button type="button" data-testid="dismiss" onClick={() => onOpenChange(false)} />
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ htmlFor, children }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

import type * as Codec from "./dozo-sealed-backup-codec";
import { openAccountBackup, sealAccountExport } from "./dozo-sealed-backup-codec";
import { DozoSealedBackupRow } from "./dozo-sealed-backup-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let downloads: { name: string; blob: Blob; revoked: boolean }[];
let consoleCalls: unknown[][];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom's Blob cannot stream; the page's can.
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("fetch", api.fetch);
  for (const fn of Object.values(api)) fn.mockReset();
  api.token.mockResolvedValue({ token: "tok/1" });
  api.onImported.mockResolvedValue(undefined);
  downloads = [];
  const urls = new Map<string, Blob>();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        const url = `blob:test/${urls.size}`;
        urls.set(url, blob);
        return url;
      },
      revokeObjectURL: (url: string) => {
        for (const download of downloads)
          if (urls.get(url) === download.blob) download.revoked = true;
      },
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({ name: this.download, blob: urls.get(this.href) as Blob, revoked: false });
  });
  consoleCalls = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  // Nothing the page sent or logged carried the password.
  for (const [url, init] of api.fetch.mock.calls as [string, RequestInit | undefined][]) {
    expect(url).not.toContain(PASSWORD);
    expect(JSON.stringify(init?.headers ?? {})).not.toContain(PASSWORD);
  }
  expect(JSON.stringify(consoleCalls.map((args) => args.map(String)))).not.toContain(PASSWORD);
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render() {
  await act(async () => root.render(<DozoSealedBackupRow onImported={api.onImported} />));
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const dialog = () => container.querySelector('[role="dialog"]');
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;
const field = (label: string) => {
  const found = [...container.querySelectorAll("label")].find((node) => node.textContent === label);
  return container.querySelector(`#${CSS.escape(found?.htmlFor ?? "")}`) as HTMLInputElement;
};

async function type(label: string, value: string) {
  const input = field(label);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: Element | null) {
  await act(async () => (element as HTMLElement).click());
}

const submit = () => byTestId("dozo-backup-submit") as HTMLButtonElement;

async function pick(file: { name: string; size: number }) {
  const input = byTestId("dozo-backup-file") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  return new Uint8Array(await (body as Blob).arrayBuffer());
}

describe("backing up the account into one sealed file", () => {
  it("seals the export in the page and downloads it as a .dozobackup", async () => {
    api.fetch.mockResolvedValue(new Response(ZIP, { status: 200 }));
    await render();
    await click(byTestId("dozo-backup-create"));
    expect(dialog()).not.toBeNull();
    await type("Password", PASSWORD);
    await type("Confirm password", PASSWORD);
    await click(submit());
    await vi.waitFor(() => expect([downloads.length, alertText()]).toEqual([1, null]), {
      timeout: 20_000,
    });
    expect(api.confirmed).toHaveBeenCalled();
    expect(api.fetch).toHaveBeenCalledWith(
      "/api/account/export?token=tok%2F1",
      expect.objectContaining({ credentials: "include" }),
    );
    const [download] = downloads;
    expect(download?.name).toMatch(/^Dozo \d{4}-\d{2}-\d{2}\.dozobackup$/);
    expect(download?.revoked).toBe(true);
    const sealed = await bodyBytes(download?.blob);
    expect(new TextDecoder().decode(sealed.subarray(0, 8))).toBe("DOZOBAK\n");
    expect(Buffer.from(sealed).includes(Buffer.from(PASSWORD))).toBe(false);
    const zip = await openAccountBackup(new NodeBlob([sealed]) as Blob, PASSWORD);
    expect(await bodyBytes(zip)).toEqual(ZIP);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(byTestId("success")).not.toBeNull();
  });

  it("asks for matching passwords of at least 8 characters before anything is fetched", async () => {
    await render();
    await click(byTestId("dozo-backup-create"));
    await type("Password", "short");
    await type("Confirm password", "short");
    expect(submit().disabled).toBe(true);
    await type("Password", PASSWORD);
    await type("Confirm password", `${PASSWORD}!`);
    await click(submit());
    expect(alertText()).toBe("Passwords do not match");
    expect(api.token).not.toHaveBeenCalled();
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("says when the export cannot be fetched, and clears the password", async () => {
    api.fetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    api.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await render();
    await click(byTestId("dozo-backup-create"));
    for (const message of ["Could not continue", "Could not reach the server"]) {
      await type("Password", PASSWORD);
      await type("Confirm password", PASSWORD);
      await click(submit());
      await vi.waitFor(() => expect(alertText()).toBe(message));
      expect(field("Password").value).toBe("");
      expect(field("Confirm password").value).toBe("");
    }
    expect(downloads).toHaveLength(0);
  });

  it("shows nothing when the identity check is dismissed", async () => {
    api.token.mockRejectedValue({ code: "IDENTITY_CONFIRMATION_REQUIRED" });
    await render();
    await click(byTestId("dozo-backup-create"));
    await type("Password", PASSWORD);
    await type("Confirm password", PASSWORD);
    await click(submit());
    await vi.waitFor(() => expect(field("Password").value).toBe(""));
    expect(alertText()).toBeNull();
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("falls back to a general message for any other failure", async () => {
    api.token.mockRejectedValue(new Error("rpc failed"));
    await render();
    await click(byTestId("dozo-backup-create"));
    await type("Password", PASSWORD);
    await type("Confirm password", PASSWORD);
    await click(submit());
    await vi.waitFor(() => expect(alertText()).toBe("Could not continue"));
  });
});

describe("restoring the account from a sealed file", () => {
  it("opens the file picker for .dozobackup files", async () => {
    await render();
    const picker = vi.spyOn(byTestId("dozo-backup-file"), "click").mockImplementation(() => {});
    await click(byTestId("dozo-backup-restore"));
    expect(picker).toHaveBeenCalled();
    await pick(undefined as never);
    expect(dialog()).toBeNull();
  });

  async function sealedFile(password = PASSWORD) {
    const sealed = await sealAccountExport(new NodeBlob([ZIP]) as Blob, password);
    return new NodeFile([new Uint8Array(await sealed.arrayBuffer())], "Dozo 2026-11-22.dozobackup");
  }

  it("opens the file in the page and imports the zip inside it", async () => {
    api.fetch.mockResolvedValue(new Response(null, { status: 200 }));
    await render();
    expect(byTestId("dozo-backup-file").getAttribute("accept")).toBe(".dozobackup");
    await pick(await sealedFile());
    await type("Password", PASSWORD);
    await click(submit());
    await vi.waitFor(() => expect(api.onImported).toHaveBeenCalled(), { timeout: 20_000 });
    const [url, init] = api.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/account/import");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/zip" },
      credentials: "include",
    });
    const body = await bodyBytes(init.body);
    expect(body).toEqual(ZIP);
    expect(Buffer.from(body).includes(Buffer.from(PASSWORD))).toBe(false);
    expect(api.recheck).toHaveBeenCalledWith(200);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(byTestId("success")).not.toBeNull();
  });

  it("says a wrong password or a damaged file in one message and imports nothing", async () => {
    await render();
    await pick(await sealedFile());
    await type("Password", "another password");
    await click(submit());
    await vi.waitFor(() => expect(alertText()).toBe("Wrong password, or the file is damaged"), {
      timeout: 20_000,
    });
    expect(field("Password").value).toBe("");
    await pick(new NodeFile(["not a backup at all"], "x.dozobackup"));
    await type("Password", PASSWORD);
    await click(submit());
    await vi.waitFor(() => expect(alertText()).toBe("Wrong password, or the file is damaged"));
    expect(api.fetch).not.toHaveBeenCalled();
    expect(api.onImported).not.toHaveBeenCalled();
  });

  it("refuses a file over the import's limit before reading it", async () => {
    await render();
    await pick({ name: "big.dozobackup", size: SEALED_ACCOUNT_FILE_MAX_BYTES + 1 });
    expect(dialog()).toBeNull();
    expect(alertText()).toBe("The file is too large");
  });

  it("shows the import's own refusal, and a server it cannot reach", async () => {
    api.fetch.mockResolvedValueOnce(
      Response.json({ error: "This export is too large to import." }, { status: 413 }),
    );
    api.fetch.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    api.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await render();
    await pick(await sealedFile());
    const messages = [
      "This export is too large to import.",
      "Could not continue",
      "Could not reach the server",
    ];
    for (const message of messages) {
      await type("Password", PASSWORD);
      await click(submit());
      await vi.waitFor(() => expect(alertText()).toBe(message), { timeout: 20_000 });
    }
    expect(api.onImported).not.toHaveBeenCalled();
  });

  it("forgets the password when the dialog closes, and stays open while it works", async () => {
    await render();
    await pick(await sealedFile());
    await type("Password", PASSWORD);
    await click(byTestId("dozo-backup-cancel"));
    expect(dialog()).toBeNull();
    await click(byTestId("dozo-backup-create"));
    expect(field("Password").value).toBe("");
    await click(byTestId("dismiss"));
    expect(dialog()).toBeNull();
    api.fetch.mockReturnValue(new Promise(() => {}));
    await pick(await sealedFile());
    await type("Password", PASSWORD);
    await click(submit());
    await vi.waitFor(() => expect(api.fetch).toHaveBeenCalled(), { timeout: 20_000 });
    await click(byTestId("dismiss"));
    expect(dialog()).not.toBeNull();
  });
});
