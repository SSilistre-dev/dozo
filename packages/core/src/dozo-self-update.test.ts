import { describe, expect, it } from "vitest";
import { chooseUpdateStrategy, validateUpdateRequest } from "./compose-update.js";
import { isOfficialRepoUrl, OFFICIAL_REPO_URL } from "./self-update.js";

// Runs on the branded tree only: until Dozo publishes its own server image, no repository is
// official, so an update never pulls upstream's unbranded image.
describe("self-update in Dozo", () => {
  it("tracks Dozo's repository", () => {
    expect(OFFICIAL_REPO_URL).toBe("https://github.com/SSilistre-dev/dozo");
  });

  it.each([
    OFFICIAL_REPO_URL,
    "git@github.com:SSilistre-dev/dozo.git",
    "https://github.com/elie222/rakazo",
  ])("does not count %s as official", (url) => {
    expect(isOfficialRepoUrl(url)).toBe(false);
  });

  it("builds Dozo's own checkout instead of pulling an image", () => {
    const result = validateUpdateRequest({ repoUrl: OFFICIAL_REPO_URL, branch: "main" });
    if (!("request" in result)) throw new Error(result.error);
    expect(result.request.official).toBe(false);
    expect(chooseUpdateStrategy(result.request).strategy).not.toBe("pull");
  });
});
