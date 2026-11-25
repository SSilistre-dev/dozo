import { describe, expect, it, vi } from "vitest";
import { StripeBillingProvider } from "./stripe-billing.js";

// Runs on the branded tree only: the checkout shape below is the brand rules'.

function fixture() {
  const sessions: URLSearchParams[] = [];
  const provider = new StripeBillingProvider({
    secretKey: "sk_test_fixture",
    webhookSecret: "whsec_fixture",
    priceId: "price_legacy",
    fetch: vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (init?.method === "POST" && path === "/v1/checkout/sessions" && body.has("mode")) {
        sessions.push(body);
        return Response.json({ url: "https://checkout.example.test/session" });
      }
      if (init?.method === "POST" && path === "/v1/prices") return Response.json({ id: "price_1" });
      return Response.json({ data: [], has_more: false });
    }),
  });
  return { provider, sessions };
}

const urls = { successUrl: "https://app.example/ok", cancelUrl: "https://app.example/no" };

describe("checkout", () => {
  it("offers no promotion code field on either plan checkout", async () => {
    const { provider, sessions } = fixture();
    await provider.createCheckout({ customerId: "cus_fixture", seats: 1, ...urls });
    await provider.createByokCheckout({
      customerId: "cus_fixture",
      tier: "max",
      amountCents: 1000,
      ...urls,
    });
    expect(sessions.map((session) => session.get("mode"))).toEqual([
      "subscription",
      "subscription",
    ]);
    for (const session of sessions) expect(session.has("allow_promotion_codes")).toBe(false);
  });
});
