// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FormEvent, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  session: { isPending: false, data: { user: { email: "ada@example.com" } } },
  issue: vi.fn(),
  assign: vi.fn(),
}));

vi.mock("../lib/auth", () => ({ authClient: { useSession: () => api.session } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("./Auth", () => ({
  submitClass: "submit",
  AuthFrame: ({
    title,
    onSubmit,
    children,
  }: {
    title: ReactNode;
    onSubmit: (event: FormEvent) => void;
    children: ReactNode;
  }) => (
    <form onSubmit={onSubmit}>
      <h1>{title}</h1>
      {children}
    </form>
  ),
}));

import { HostedLoginPage } from "./dozo-hosted-login";

const AUDIENCE = "a".repeat(43);
const CALLBACK = "http://127.0.0.1:5173/api/auth/dozo/hosted-login/callback";
const PAGE = `/dozo/hosted-login?audience=${AUDIENCE}&return=${encodeURIComponent(CALLBACK)}`;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Where() {
  const { pathname } = useLocation();
  return <output>{pathname}</output>;
}

async function open(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/dozo/hosted-login" element={<HostedLoginPage />} />
            <Route path="/app" element={<p>app</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

const text = () => container.textContent ?? "";
const where = () => container.querySelector("output")?.textContent;
const button = () => container.querySelector("button");

async function agree() {
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.issue.mockReset();
  api.assign.mockReset();
  vi.stubGlobal("fetch", api.issue);
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    assign: api.assign,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the page that hands the account to this computer", () => {
  it("names the account and hands nothing over before the user agrees", async () => {
    await open(PAGE);
    expect(container.querySelector("h1")?.textContent).toBe("Sign in on this computer?");
    expect(text()).toContain("ada@example.com");
    expect(api.issue).not.toHaveBeenCalled();
    expect(
      [...container.querySelectorAll("a")].map((a) => `${a.textContent} ${a.getAttribute("href")}`),
    ).toEqual(["Cancel /app"]);
  });

  it("asks the server for the token once agreed and goes where the server says", async () => {
    const answer = deferred<Response>();
    api.issue.mockReturnValue(answer.promise);
    await open(PAGE);
    await agree();
    expect(button()?.disabled).toBe(true);
    expect(api.issue).toHaveBeenCalledWith("/api/auth/dozo/hosted-login/issue", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audience: AUDIENCE, return: CALLBACK }),
    });
    await act(async () => answer.resolve(Response.json({ url: `${CALLBACK}?token=t` })));
    await vi.waitFor(() => expect(api.assign).toHaveBeenCalledWith(`${CALLBACK}?token=t`));
  });

  it("says it could not continue when the server refuses, and goes nowhere", async () => {
    api.issue.mockResolvedValue(new Response("", { status: 400 }));
    await open(PAGE);
    await agree();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not continue"),
    );
    expect(api.assign).not.toHaveBeenCalled();
    expect(button()?.disabled).toBe(false);
  });

  it.each([
    "/dozo/hosted-login",
    `/dozo/hosted-login?audience=${AUDIENCE}`,
    `/dozo/hosted-login?return=${encodeURIComponent(CALLBACK)}`,
  ])("goes to the app from %s, which asks for nothing", async (path) => {
    await open(path);
    expect(where()).toBe("/app");
  });
});
