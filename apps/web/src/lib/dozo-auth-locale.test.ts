import { expect, it, vi } from "vitest";

vi.mock("./i18n", () => ({ getActiveUiLocale: () => "tr" }));

import { sendUiLocale } from "./dozo-auth-locale";

it("asks for emails in the language the app is shown in, keeping the other headers", () => {
  const request = { headers: new Headers({ "accept-language": "en-US,en;q=0.9", "x-kept": "1" }) };
  expect(sendUiLocale(request)).toBe(request);
  expect(request.headers.get("accept-language")).toBe("tr");
  expect(request.headers.get("x-kept")).toBe("1");
});
