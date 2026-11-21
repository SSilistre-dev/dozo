// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ devices: vi.fn() }));

vi.mock("../lib/user-devices", () => ({ listUserDevices: api.devices }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({ buttonVariants: () => "button" }));
vi.mock("./SettingsRows", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ label, control }: { label: ReactNode; control: ReactNode }) => (
    <div>
      <span>{label}</span>
      {control}
    </div>
  ),
}));

import { DESKTOP_SETTINGS, DozoConnectThisComputer, DozoDesktopAppRow } from "./dozo-desktop-app";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function show(node: ReactNode) {
  await act(async () => root.render(node));
}

function links() {
  return [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.devices.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.dozoDesktopShell;
});

describe("DozoDesktopAppRow", () => {
  it("shows nothing in a browser", async () => {
    await show(<DozoDesktopAppRow />);
    expect(container.innerHTML).toBe("");
  });

  it("opens the app's Settings in the desktop app", async () => {
    window.dozoDesktopShell = true;
    await show(<DozoDesktopAppRow />);
    expect(container.textContent).toContain("Desktop app");
    expect(links()).toEqual([["Open", "dozo-app://settings"]]);
    expect(DESKTOP_SETTINGS).toBe("dozo-app://settings");
  });
});

describe("DozoConnectThisComputer", () => {
  it("shows nothing in a browser and does not ask for the computers", async () => {
    await show(<DozoConnectThisComputer />);
    expect(container.innerHTML).toBe("");
    expect(api.devices).not.toHaveBeenCalled();
  });

  it("offers to connect while no computer is connected, once the list is in", async () => {
    window.dozoDesktopShell = true;
    const listed = deferred<{ deviceId: string; name: string; connected: boolean }[]>();
    api.devices.mockReturnValue(listed.promise);
    await show(<DozoConnectThisComputer />);
    expect(container.innerHTML).toBe("");
    await act(async () => listed.resolve([{ deviceId: "d1", name: "Laptop", connected: false }]));
    expect(links()).toEqual([["Connect this computer", "dozo-app://settings"]]);
  });

  it("stays away while a computer is connected or the list fails", async () => {
    window.dozoDesktopShell = true;
    api.devices.mockResolvedValue([{ deviceId: "d1", name: "Laptop", connected: true }]);
    await show(<DozoConnectThisComputer />);
    expect(container.innerHTML).toBe("");
    act(() => root.unmount());
    root = createRoot(container);
    api.devices.mockRejectedValue(new Error("offline"));
    await show(<DozoConnectThisComputer />);
    expect(container.innerHTML).toBe("");
  });
});
