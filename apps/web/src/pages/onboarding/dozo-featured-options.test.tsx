// @vitest-environment jsdom

import { DOZO_FEATURED_MODEL_OPTIONS } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../lib/model-auth";
import type { OnboardingModel } from "./use-onboarding-model";

vi.mock("../../lib/rpc", () => ({ rpc: {} }));

import { useOnboardingModel } from "./use-onboarding-model";

const entry = (provider: string, extra: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  provider,
  providerName: provider,
  id: `${provider}-model`,
  label: `${provider} model`,
  billing: "byok",
  ...extra,
});

// Every featured provider, as the catalog describes it; anthropic connects both ways.
const catalog = [
  entry("openai-codex", { auth: "oauth" }),
  entry("anthropic", { auth: "both" }),
  entry("openai"),
  entry("openrouter", { auth: "both" }),
  entry("google"),
  entry("openai-compatible"),
  entry("groq"),
];

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function options(billingEnabled: boolean): OnboardingModel["providerOptions"] {
  let seen: OnboardingModel["providerOptions"] | undefined;
  function Probe() {
    seen = useOnboardingModel({
      catalog,
      billingEnabled,
      onConnected: () => undefined,
    }).providerOptions;
    return null;
  }
  act(() => root?.render(<Probe />));
  if (!seen) throw new Error("the hook did not render");
  return seen;
}

it("names every featured way exactly as upstream's onboarding list writes it", () => {
  const { main, rest } = options(false);
  const offered = [...main, ...rest].map((option) => option.value);
  for (const value of DOZO_FEATURED_MODEL_OPTIONS) expect(offered, value).toContain(value);
});

it("puts upstream's credits choice first and only while billing offers it", () => {
  const withCredits = options(true).main.map((option) => option.value);
  expect(DOZO_FEATURED_MODEL_OPTIONS).not.toContain(withCredits[0]);
  expect(withCredits.slice(1)).toEqual(options(false).main.map((option) => option.value));
});
