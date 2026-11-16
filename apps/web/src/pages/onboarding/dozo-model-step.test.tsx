// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upstream: vi.fn(),
  panel: vi.fn(),
  assign: vi.fn(),
}));

vi.mock("./model-step", () => ({
  ModelStep: (props: object) => {
    mocks.upstream(props);
    return <div data-testid="upstream" />;
  },
}));
vi.mock("../dozo-local-models", () => ({
  DozoLocalModels: (props: { onConnected: () => void }) => {
    mocks.panel(props);
    return (
      <button type="button" data-testid="panel" onClick={props.onConnected}>
        panel
      </button>
    );
  },
}));

import { ModelStep } from "./dozo-model-step";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", { assign: mocks.assign });
  mocks.upstream.mockClear();
  mocks.panel.mockClear();
  mocks.assign.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(props: ComponentProps<typeof ModelStep>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<ModelStep {...props} />));
}

const props = { model: { id: "model-state" }, fieldId: "field-1" } as unknown as ComponentProps<
  typeof ModelStep
>;

it("passes its props to upstream's step unchanged and renders the panel under it", () => {
  render(props);

  expect(mocks.upstream).toHaveBeenCalledWith(props);
  const children = [...container.children].map((node) => node.getAttribute("data-testid"));
  expect(children).toEqual(["upstream", null]);
  expect(container.children[1]?.contains(container.querySelector("[data-testid='panel']"))).toBe(
    true,
  );
});

it("reloads onboarding only once a local model is connected", () => {
  render(props);
  expect(mocks.assign).not.toHaveBeenCalled();

  act(() => container.querySelector<HTMLButtonElement>("[data-testid='panel']")?.click());

  expect(mocks.assign).toHaveBeenCalledExactlyOnceWith("/onboarding");
});
