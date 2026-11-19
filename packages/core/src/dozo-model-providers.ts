/**
 * Model providers people pick by name in onboarding: product data, like `model-providers.ts`.
 *
 * The ways to connect a model offered first, in order; the first one present is preselected. Each is
 * an onboarding option value: a provider id, followed by `:sign-in` or `:key` when its catalog entry
 * offers both. Every other provider stays one step away, under "More".
 */
export const DOZO_FEATURED_MODEL_OPTIONS: readonly string[] = [
  "openai-codex",
  "anthropic:sign-in",
  "openai",
  "anthropic:key",
  "openrouter",
  "google",
  // A server the person runs or rents themselves, local models included.
  "openai-compatible",
];

/**
 * The page where a provider's API keys are made, by provider id. Each was opened with curl on
 * 2026-11-19 and answered with the key page or a sign-in that returns to it (OpenAI's sits behind a
 * browser check). A provider without a checked page has no entry.
 */
const KEY_PAGES: Readonly<Record<string, string>> = {
  anthropic: "https://platform.claude.com/settings/keys",
  google: "https://aistudio.google.com/apikey",
  groq: "https://console.groq.com/keys",
  huggingface: "https://huggingface.co/settings/tokens",
  mistral: "https://console.mistral.ai/api-keys",
  moonshotai: "https://platform.moonshot.ai/console/api-keys",
  nvidia: "https://build.nvidia.com/settings/api-keys",
  openai: "https://platform.openai.com/api-keys",
  openrouter: "https://openrouter.ai/settings/keys",
  together: "https://api.together.ai/settings/api-keys",
  zai: "https://z.ai/manage-apikey/apikey-list",
};

/** Where to get an API key for `provider`, when a page is known. */
export function dozoModelKeyPage(provider: string): string | undefined {
  return Object.hasOwn(KEY_PAGES, provider) ? KEY_PAGES[provider] : undefined;
}
