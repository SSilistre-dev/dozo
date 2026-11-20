import type { Env as RelayEnv } from "../src/env.js";
import type * as relay from "../src/index.js";

// What `cloudflare:workers` exposes in the tests: this Worker's bindings and exports.
declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof relay;
      durableNamespaces: "Channel" | "Registry";
    }
    interface Env extends RelayEnv {}
  }
}
