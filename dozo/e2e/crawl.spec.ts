import { runSurface, test } from "./fixtures";
import { SURFACES } from "./surfaces";

// One test per surface of surfaces.ts, in the light and the dark theme. The signed-in surfaces
// share the session the setup project saved; the signed-out ones start without it.
for (const surface of SURFACES.filter((s) => !s.signedOut)) {
  test(surface.name, async ({ page, theme }) => {
    test.skip(surface.once === true && theme !== "light", "runs once, in the light theme");
    if (surface.slow) test.setTimeout(surface.slow);
    await runSurface(surface, page, theme);
  });
}

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  for (const surface of SURFACES.filter((s) => s.signedOut)) {
    test(surface.name, async ({ page, theme }) => {
      test.skip(surface.once === true && theme !== "light", "runs once, in the light theme");
      await runSurface(surface, page, theme);
    });
  }
});
