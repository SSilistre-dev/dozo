import { relayPairingLink } from "@rakazo/core";
import { expect, it } from "vitest";
import { linkedOffer, pairingRoute } from "./dozo-pair-link";

it("reads the offer from the link the computer writes", () => {
  expect(linkedOffer(relayPairingLink("abc"))).toBe("abc");
});

it("still reads the upstream-scheme link older computers write", () => {
  expect(linkedOffer("rakazo://dozo-pair#abc")).toBe("abc");
});

it("opens the pairing screen for the Dozo pairing link only", () => {
  expect(pairingRoute(relayPairingLink("abc"))).toBe("/dozo-pair");
  expect(pairingRoute("dozo://pair/#abc")).toBe("/dozo-pair");
  expect(pairingRoute("dozo://pair")).toBe("/dozo-pair");
  for (const path of [
    "dozo://pairing#abc",
    "dozo://pair/more#abc",
    "rakazo://pair#abc",
    "rakazo://dozo-pair#abc",
    "rakazo:///thread?botId=bot-1",
    "/pair",
  ]) {
    expect(pairingRoute(path)).toBe(path);
  }
});
