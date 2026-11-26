vi.mock("./settings/ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "./api/api-test-helpers";
import { restoreSessionToken } from "./api/session.js";
import { signIn, signUp } from "./auth/api-auth.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./notifications/live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./api/network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

// A server with a mail provider opens no session at sign-up (`token: null`) and refuses an
// unverified account's password sign-in with EMAIL_NOT_VERIFIED. The app keeps no session from
// either, and says so in the fork's words. Runs on the branded tree (the message is the fork's).

describe("sign-up and sign-in on a server that asks for the mailbox first", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await restoreSessionToken("");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a sign-up without a token needs the mailbox and saves no session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ token: null, user: { id: "u1" } })),
    );
    await expect(signUp("new@example.test", "correct horse", "New")).resolves.toEqual({
      verificationRequired: true,
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("a repeated sign-up gets the same answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ token: null, user: { id: "someone-else" } })),
    );
    await expect(signUp("old@example.test", "another horse", "Old")).resolves.toEqual({
      verificationRequired: true,
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("a sign-in the server refuses as unverified says Email verification required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
          { status: 403 },
        ),
      ),
    );
    await expect(signIn("new@example.test", "correct horse")).rejects.toMatchObject({
      message: "Email verification required",
      status: 403,
      code: "EMAIL_NOT_VERIFIED",
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });
});
