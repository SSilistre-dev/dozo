// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { i18n } from "@lingui/core";
import { MODEL_KEY_REJECTED_ERROR } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingModel } from "./use-onboarding-model";

const mocks = vi.hoisted(() => ({
  upstream: vi.fn(),
  panel: vi.fn(),
  assign: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./model-step", () => ({
  ModelStep: (props: { model: OnboardingModel; fieldId: string }) => {
    mocks.upstream(props);
    return (
      <div data-testid="upstream">
        {props.fieldId === "no-key" ? null : (
          <input id={`${props.fieldId}-api-key`} defaultValue="sk-wrong" />
        )}
        <p data-testid="error">{props.model.error}</p>
      </div>
    );
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
vi.mock("../../lib/rpc", () => ({ rpc: { billing: { status: mocks.status } } }));

import { dozoCreditsOnSale, dozoProviderChoices, ModelStep } from "./dozo-model-step";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", { assign: mocks.assign });
  mocks.upstream.mockClear();
  mocks.panel.mockClear();
  mocks.assign.mockClear();
  mocks.status.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  vi.unstubAllGlobals();
});

const option = (value: string, label = value) => ({ value, label });
// Upstream's shape: its own short list (credits first when offered), then everyone else by name.
const upstreamOptions = (credits: boolean) => ({
  main: [
    ...(credits ? [option("__credits__", "Credits")] : []),
    option("openai-codex"),
    option("anthropic:sign-in"),
    option("openai"),
    option("anthropic:key"),
    option("openrouter"),
    option("google"),
  ],
  rest: [option("amazon-bedrock"), option("groq"), option("openai-compatible"), option("zai")],
});

function fakeModel(overrides: Partial<OnboardingModel> = {}): OnboardingModel {
  const options = upstreamOptions(false);
  return {
    providerOptions: options,
    providerItems: [...options.main, ...options.rest],
    providerValue: null,
    credits: false,
    chooseProvider: vi.fn(),
    error: null,
    provider: "",
    selected: undefined,
    ...overrides,
  } as unknown as OnboardingModel;
}

function render(props: ComponentProps<typeof ModelStep>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<ModelStep {...props} />));
}

function rerender(props: ComponentProps<typeof ModelStep>) {
  act(() => root?.render(<ModelStep {...props} />));
}

const lastModel = (): OnboardingModel => mocks.upstream.mock.lastCall?.[0].model;
const values = (options: { value: string }[]) => options.map((entry) => entry.value);

describe("dozoCreditsOnSale", () => {
  it("is true while the deployment sells credits", async () => {
    mocks.status.mockResolvedValue({ creditPurchasesEnabled: true });
    const signal = new AbortController().signal;
    await expect(dozoCreditsOnSale(signal)).resolves.toBe(true);
    expect(mocks.status).toHaveBeenCalledWith(undefined, { signal });
  });

  it("is true for a server that does not report it, as upstream reads the flag", async () => {
    mocks.status.mockResolvedValue({});
    await expect(dozoCreditsOnSale(new AbortController().signal)).resolves.toBe(true);
  });

  it("is false while credit purchases are off", async () => {
    mocks.status.mockResolvedValue({ creditPurchasesEnabled: false });
    await expect(dozoCreditsOnSale(new AbortController().signal)).resolves.toBe(false);
  });

  it("is false when billing cannot say", async () => {
    mocks.status.mockRejectedValue(new Error("no billing"));
    await expect(dozoCreditsOnSale(new AbortController().signal)).resolves.toBe(false);
  });
});

describe("dozoProviderChoices", () => {
  it("lists the featured ways in catalog order, then More, with the rest folded", () => {
    const choices = dozoProviderChoices(upstreamOptions(false), false, "More");
    expect(values(choices.main)).toEqual([
      "openai-codex",
      "anthropic:sign-in",
      "openai",
      "anthropic:key",
      "openrouter",
      "google",
      "openai-compatible",
      "__dozo_more__",
    ]);
    expect(choices.main.at(-1)?.label).toBe("More");
    expect(choices.rest).toEqual([]);
    expect(choices.first?.value).toBe("openai-codex");
  });

  it("keeps credits first when they are offered", () => {
    const choices = dozoProviderChoices(upstreamOptions(true), false, "More");
    expect(values(choices.main).slice(0, 2)).toEqual(["__credits__", "openai-codex"]);
    expect(choices.first?.value).toBe("openai-codex");
  });

  it("shows no credits when upstream offers none", () => {
    const choices = dozoProviderChoices(upstreamOptions(false), true, "More");
    expect(values([...choices.main, ...choices.rest])).not.toContain("__credits__");
  });

  it("unfolds the rest in upstream's order, without More", () => {
    const choices = dozoProviderChoices(upstreamOptions(false), true, "More");
    expect(values(choices.main)).not.toContain("__dozo_more__");
    expect(values(choices.rest)).toEqual(["amazon-bedrock", "groq", "zai"]);
  });

  it("offers no More when nothing is left over, and no preselection without featured ways", () => {
    const choices = dozoProviderChoices(
      { main: [option("openai")], rest: [option("groq")] },
      false,
      "More",
    );
    expect(values(choices.main)).toEqual(["openai", "__dozo_more__"]);
    const onlyOthers = dozoProviderChoices({ main: [], rest: [option("groq")] }, false, "More");
    expect(onlyOthers.first).toBeUndefined();
    const onlyFeatured = dozoProviderChoices({ main: [option("google")], rest: [] }, false, "More");
    expect(values(onlyFeatured.main)).toEqual(["google"]);
  });
});

describe("ModelStep", () => {
  it("hands upstream the short list and every label, and renders the panel under it", () => {
    render({ model: fakeModel(), fieldId: "f" });

    const model = lastModel();
    expect(values(model.providerOptions.main)).toContain("__dozo_more__");
    expect(model.providerOptions.rest).toEqual([]);
    expect(values(model.providerItems)).toContain("zai");
    const children = [...container.children].map((node) => node.getAttribute("data-testid"));
    expect(children).toEqual(["upstream", null]);
  });

  it("preselects the first featured way once, and never over a choice already made", () => {
    const chooseProvider = vi.fn();
    render({ model: fakeModel({ chooseProvider }), fieldId: "f" });
    expect(chooseProvider).toHaveBeenCalledExactlyOnceWith("openai-codex");

    rerender({ model: fakeModel({ chooseProvider }), fieldId: "f" });
    expect(chooseProvider).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    root = undefined;
    const kept = vi.fn();
    render({ model: fakeModel({ chooseProvider: kept, providerValue: "groq" }), fieldId: "f" });
    expect(kept).not.toHaveBeenCalled();
  });

  it("waits for the catalog before preselecting", () => {
    const chooseProvider = vi.fn();
    const empty = { main: [], rest: [] };
    render({
      model: fakeModel({ chooseProvider, providerOptions: empty, providerItems: [] }),
      fieldId: "f",
    });
    expect(chooseProvider).not.toHaveBeenCalled();

    rerender({ model: fakeModel({ chooseProvider }), fieldId: "f" });
    expect(chooseProvider).toHaveBeenCalledExactlyOnceWith("openai-codex");
  });

  it("unfolds every provider on More, and passes any other choice on", () => {
    const chooseProvider = vi.fn();
    render({ model: fakeModel({ chooseProvider, providerValue: "openai" }), fieldId: "f" });

    act(() => lastModel().chooseProvider("__dozo_more__"));
    expect(chooseProvider).not.toHaveBeenCalled();
    expect(values(lastModel().providerOptions.rest)).toEqual(["amazon-bedrock", "groq", "zai"]);

    act(() => lastModel().chooseProvider("groq"));
    expect(chooseProvider).toHaveBeenCalledExactlyOnceWith("groq");
  });

  it("says plainly that the provider refused the key, and puts the cursor back in the field", () => {
    render({
      model: fakeModel({
        providerValue: "openrouter",
        provider: "openrouter",
        selected: { providerName: "OpenRouter" } as OnboardingModel["selected"],
        error: MODEL_KEY_REJECTED_ERROR,
      }),
      fieldId: "f",
    });

    expect(container.querySelector("[data-testid='error']")?.textContent).toBe(
      "OpenRouter rejected the API key. Check your connection settings.",
    );
    const field = container.querySelector<HTMLInputElement>("#f-api-key");
    expect(document.activeElement).toBe(field);
    expect(field?.selectionStart).toBe(0);
    expect(field?.selectionEnd).toBe("sk-wrong".length);
  });

  it("names the provider id when the catalog has no name, and leaves other errors alone", () => {
    render({
      model: fakeModel({
        providerValue: "groq",
        provider: "groq",
        error: MODEL_KEY_REJECTED_ERROR,
      }),
      fieldId: "f",
    });
    expect(container.querySelector("[data-testid='error']")?.textContent).toMatch(/^groq rejected/);

    rerender({
      model: fakeModel({ providerValue: "groq", provider: "groq", error: "Could not save model" }),
      fieldId: "f",
    });
    expect(lastModel().error).toBe("Could not save model");
  });

  it("leaves focus alone when no key field is shown", () => {
    render({
      model: fakeModel({
        providerValue: "groq",
        provider: "groq",
        error: MODEL_KEY_REJECTED_ERROR,
      }),
      fieldId: "no-key",
    });
    expect(document.activeElement).toBe(document.body);
  });

  it("offers Later only when the page hands it a way on", () => {
    render({ model: fakeModel(), fieldId: "f" });
    expect(container.textContent).not.toContain("Later");

    const onLater = vi.fn();
    rerender({ model: fakeModel(), fieldId: "f", onLater });
    const later = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Later",
    );
    act(() => later?.click());
    expect(onLater).toHaveBeenCalledTimes(1);
  });

  it("reloads onboarding only once a local model is connected", () => {
    render({ model: fakeModel(), fieldId: "f" });
    expect(mocks.assign).not.toHaveBeenCalled();

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='panel']")?.click());

    expect(mocks.assign).toHaveBeenCalledExactlyOnceWith("/onboarding");
  });
});

it("reuses messages the Turkish catalog already translates", () => {
  const catalog = readFileSync(
    path.join(process.cwd(), "packages/i18n/locales/tr/messages.po"),
    "utf8",
  );
  for (const message of [
    "More",
    "Later",
    "{provider} rejected the API key. Check your connection settings.",
  ]) {
    const entry = new RegExp(`^msgid "${message.replace(/[{}.]/g, "\\$&")}"\\nmsgstr "(.+)"$`, "m");
    expect(catalog, message).toMatch(entry);
  }
});
