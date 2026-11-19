import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { beforeEach, expect, it } from "vitest";
import { classifyModelConnectionFailure } from "../lib/model-connection-preflight";
import { preflightMessage } from "./dozo-preflight-message";

beforeEach(() => {
  i18n.load({ en: {}, tr: tr as Messages });
  i18n.activate("tr");
});

/** What the model server probe answers a fake key, as the RPC client throws it. */
const probeRefused = Object.assign(
  new Error("Model server returned 401. You can still Connect with an explicit model id."),
  { status: 400 },
);

it("says a refused key in Turkish, never the server's English", () => {
  const failure = classifyModelConnectionFailure(probeRefused);
  expect(failure.outcome).toBe("unauthorized");
  expect(preflightMessage(failure)).toBe("Kimlik doğrulama başarısız.");
});

it("gives every kind read from the provider's answer its own sentence", () => {
  const said = (message: string) =>
    preflightMessage(classifyModelConnectionFailure(new Error(message)));
  expect(said("Request timed out")).toBe("Bağlantı zaman aşımına uğradı.");
  expect(said("429 rate limit")).toBe("Sağlayıcı istek hızını sınırlıyor.");
  expect(said("ECONNREFUSED")).toBe("Model sunucusuna ulaşılamadı.");
  expect(said("Model server returned invalid JSON.")).toBe("Bağlantı testi başarısız.");
});

it("keeps the lines the app wrote itself", () => {
  const failure = {
    outcome: "missing_fields" as const,
    message: "Bir API anahtarı girin",
    nextAction: "",
  };
  expect(preflightMessage(failure)).toBe("Bir API anahtarı girin");
});
