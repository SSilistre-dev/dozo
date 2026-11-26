import { describe, expect, it } from "vitest";
import { pageBrowserFillLoginRequest } from "./dozo-page-browser-protocol.js";
import { hostComputerRequest } from "./computers/host/host-computer-protocol.js";

const request = {
  method: "pageBrowserFillLogin",
  botId: "bot-1",
  runId: "run-1",
  ref: 42,
  origin: "https://login.example.test",
  handle: "AbCdEfGhIjKlMnOpQrStUv",
  field: "password",
};

describe("pageBrowserFillLogin", () => {
  it("names the node, the approved site, the handle and the field, and nothing else", () => {
    expect(pageBrowserFillLoginRequest.parse(request)).toEqual(request);
    // Part of what the device protocol carries, so the hub passes it on.
    expect(hostComputerRequest.parse(request)).toEqual(request);
    for (const field of ["username", "code"])
      expect(pageBrowserFillLoginRequest.safeParse({ ...request, field }).success).toBe(true);
  });

  it("carries no value: one a caller adds is dropped, not sent", () => {
    expect(pageBrowserFillLoginRequest.parse({ ...request, text: "hunter2", value: "x" })).toEqual(
      request,
    );
  });

  it.each([
    ["a field it does not know", { field: "pin" }],
    ["a short handle", { handle: "short" }],
    ["a handle with a space", { handle: "AbCdEfGhIjKlMnOpQrSt U" }],
    ["a site that is not an https origin", { origin: "http://login.example.test" }],
    ["a site with a path", { origin: "https://login.example.test/in" }],
    ["a node that is not a whole number", { ref: 1.5 }],
    ["a negative node", { ref: -1 }],
    ["no bot", { botId: "" }],
  ])("refuses %s", (_name, change) => {
    expect(pageBrowserFillLoginRequest.safeParse({ ...request, ...change }).success).toBe(false);
  });
});
