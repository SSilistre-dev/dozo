import { expect, it } from "vitest";
import { normalizeRunError } from "./run-error.js";

// Runs on the branded tree only: the brand rules make a named provider the sentence's subject and
// know the busy-host message.

it("names the provider that rejected a key as the subject, without a possessive", () => {
  expect(
    normalizeRunError(
      '401: {"message":"Incorrect API key: sk-fake-placeholder; https://api.openai.com"}',
    ).summary,
  ).toBe("OpenAI rejected the API key. Check your connection settings.");
  expect(
    normalizeRunError(
      '{"error":{"type":"rate_limit_error","message":"Slow down","metadata":{"provider":"Anthropic"}}}',
    ).summary,
  ).toBe("Anthropic is rate limiting requests. Try again shortly.");
  expect(
    normalizeRunError('401: {"message":"No auth credentials found","code":"openrouter_auth"}')
      .summary,
  ).toBe("OpenRouter rejected the API key. Check your connection settings.");
});

it("still speaks of a provider it cannot name as the member's own", () => {
  expect(normalizeRunError('403: {"message":"Unauthorized API key"}').summary).toBe(
    "Your model provider rejected the API key. Check your connection settings.",
  );
});

it("shows the busy-host message as its own sentence, not the provider's generic summary", () => {
  // The text of ComputerCapacityError in the adapters, whose own test holds its literal.
  const message = "All computers are busy. Try again shortly.";
  expect(normalizeRunError(message).summary).toBe(message);
});
