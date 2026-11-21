import type { ConnectorTool } from "@rakazo/adapter-kit";

export const BROWSER_SIGN_IN_TOOL = "browser_sign_in";

/** The person signs in to a site themselves, in the bot's own browser on their computer. */
export const browserSignInTool: ConnectorTool = {
  name: BROWSER_SIGN_IN_TOOL,
  description:
    "Ask the user to sign in to a site themselves in your browser on their computer. It opens the site's home page there and shows them Done and Cancel; you see nothing of it, and learn only whether they signed in. Use it when a site needs the user signed in; never ask for their password or code.",
  inputSchema: {
    type: "object",
    properties: {
      site: { type: "string", description: "The site, such as x.com." },
    },
    required: ["site"],
  },
};
