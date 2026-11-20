import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url).href);

// The same aliases as `wrangler.jsonc`: the protocol comes from the repository's packages.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  resolve: {
    alias: {
      "@rakazo/contracts": here("../../../packages/contracts/src/dozo-relay.ts"),
      "@dozo/relay-core": here("../../../packages/core/src"),
      zod: here("./node_modules/zod"),
    },
  },
});
