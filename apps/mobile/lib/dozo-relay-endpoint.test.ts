import { describe, expect, it } from "vitest";
import { relayOrigin } from "./dozo-relay-connection";
import { apiBaseWarning, displayApiHost, embeddableScreenUrl } from "./dozo-relay-endpoint";

const computer = relayOrigin("q83vEjRWeJCrze8SNFZ4kA");

describe("endpoint helpers with a paired computer", () => {
  it("names the computer instead of its internal address", () => {
    expect(displayApiHost(computer)).toBe("Your computer");
    expect(displayApiHost("https://app.example.invalid")).toBe("app.example.invalid");
    expect(displayApiHost("not a url")).toBe("not a url");
  });

  it("keeps Android's notification service off for a computer, and says why", () => {
    expect(apiBaseWarning(computer)).toMatch(/direct connection/);
    expect(apiBaseWarning("https://app.example.invalid")).toBeNull();
    expect(apiBaseWarning("http://public.example.com")).toMatch(/https/);
  });

  it("does not load a computer's live screen in a web view", () => {
    expect(embeddableScreenUrl("https://screen.example.invalid/novnc/", computer)).toBeNull();
    expect(
      embeddableScreenUrl("https://screen.example.invalid/novnc/", "https://app.example.invalid"),
    ).toBe("https://screen.example.invalid/novnc/");
  });
});
