import { installRelayFetch } from "./dozo-relay-fetch";

installRelayFetch(globalThis);

// The root layout's first import comes through here, so `fetch` reaches paired computers before
// any of the layout's other modules run.
export { i18n } from "@lingui/core";
