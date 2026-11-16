// Offline tests of logic.ts with Node's built-in runner (`make olc`): the route check that decides
// whether a surface really reached the screen it declares, and the coverage verdict. Node strips
// the types of logic.ts itself; the file has no imports, so no Playwright is needed.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { declaredKeysVerdict, matchesRoute, routeKeysMissed } from "./logic.ts";

test("matchesRoute: literals, parameters, optional last parameter, splat", () => {
  const table = [
    // [pattern, url, expected]
    ["/", "/", true],
    ["/", "http://127.0.0.1:5173/", true],
    ["/", "/sign-in", false],
    ["/app", "/app", true],
    ["/app", "/app/", true], // a trailing slash is the same route
    ["/app", "/APP", true], // literals are case-insensitive, as the router reads them
    ["/app", "/app/abc", false],
    ["/app", "/application", false],
    ["/app/:botId", "/app/abc", true],
    ["/app/:botId", "/app", false], // a parameter is one non-empty segment
    ["/app/:botId", "/app/abc/def", false],
    ["/app/g/:groupId", "/app/g/xyz", true],
    ["/app/g/:groupId", "/app/x/xyz", false],
    ["/app/:botId", "/app/g", true], // matches the pattern, as the router would
    ["/onboarding/:step?", "/onboarding", true],
    ["/onboarding/:step?", "/onboarding/survey", true],
    ["/onboarding/:step?", "/onboarding/survey/more", false],
    ["/onboarding/:step?", "/elsewhere", false],
    ["/invite/:token", "/invite/e2e-not-an-invite?next=%2Fapp#x", true], // query, hash: ignored
    ["/mcp/oauth/callback", "/mcp/oauth/callback?code=1", true],
    ["/mcp/oauth/callback", "/mcp/oauth", false],
    ["*", "/anything/at/all", true],
    ["*", "about:blank", true],
    ["/sign-in", "about:blank", false],
  ];
  for (const [pattern, url, expected] of table) {
    assert.equal(matchesRoute(pattern, url), expected, `${pattern} vs ${url}`);
  }
});

test("routeKeysMissed: a route key counts only when a visited URL matches it", () => {
  const visited = ["http://h/app/artifacts", "http://h/app/artifacts/missing"];
  const both = ["route:/app/artifacts", "route:/app/artifacts/:artifactId"];
  assert.deepEqual(routeKeysMissed(both, visited), []);
  const board = ["route:/app/artifacts", "route:/app/board"];
  assert.deepEqual(routeKeysMissed(board, visited), ["route:/app/board"]);
  // Not a route key: not judged here (settings sections and overlays carry their own checks).
  assert.deepEqual(routeKeysMissed(["settings:models", "overlay:mcp", "onboarding:bot"], []), []);
  assert.deepEqual(routeKeysMissed([], visited), []);
  // No visit at all misses every route key.
  assert.deepEqual(routeKeysMissed(["route:/app"], []), ["route:/app"]);
});

test("routeKeysMissed: landsOn names where a redirected key ends, only for that key", () => {
  const landsOn = { "route:/": { path: "/sign-in", reason: "signed out: root goes to sign-in" } };
  const visited = ["http://h/sign-in"];
  assert.deepEqual(routeKeysMissed(["route:/"], visited), ["route:/"]);
  assert.deepEqual(routeKeysMissed(["route:/"], visited, landsOn), []);
  // The override belongs to its own key: another key is still judged on its own pattern.
  assert.deepEqual(routeKeysMissed(["route:/app"], visited, landsOn), ["route:/app"]);
  // The key's own pattern still counts when the override does not match.
  assert.deepEqual(routeKeysMissed(["route:/"], ["http://h/"], landsOn), []);
});

test("declaredKeysVerdict: a declared key nobody visited fails, if every surface ran", () => {
  const visited = new Set(["route:/app", "settings:models"]);
  const declared = ["settings:models", "route:/b", "route:/app", "overlay:a", "route:/b"];
  // Sorted, each once.
  assert.deepEqual(declaredKeysVerdict(true, declared, visited), {
    checked: true,
    unvisited: ["overlay:a", "route:/b"],
  });
  // Everything visited: checked, nothing unvisited (the run passes).
  const passing = declaredKeysVerdict(true, ["route:/app"], visited);
  assert.deepEqual(passing, { checked: true, unvisited: [] });
  // A filtered run is not judged, even with keys unvisited.
  const filtered = declaredKeysVerdict(false, declared, visited);
  assert.deepEqual(filtered, { checked: false, unvisited: [] });
});
