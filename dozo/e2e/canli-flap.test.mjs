// Offline test of the live run's answer to this machine's own network flaps (canli/fence.ts,
// guardFlaps): a sub-resource that fails with a client-side network error reloads the page, at
// most twice, each time with a note in the report; the site's own failures are never retried and
// stay for the watcher. A fake page stands in for Playwright's.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FLAP_RELOADS, guardFlaps, isNetworkFlap } from "./canli/fence.ts";

const MAIN = { name: "main" };

function fakePage({ gotoFails = [] } = {}) {
  const listeners = [];
  const page = {
    reloads: 0,
    gotos: [],
    on(event, fn) {
      assert.equal(event, "requestfailed");
      listeners.push(fn);
    },
    mainFrame: () => MAIN,
    async reload() {
      page.reloads++;
    },
    async goto(url) {
      page.gotos.push(url);
      const failure = gotoFails.shift();
      if (failure) {
        // The browser reports the document's own failure before goto rejects.
        page.fail(failure, url, { navigation: true });
        throw new Error(`page.goto: ${failure} at ${url}`);
      }
      return "ok";
    },
    fail(errorText, url, { navigation = false } = {}) {
      const request = {
        url: () => url,
        method: () => "GET",
        failure: () => ({ errorText }),
        isNavigationRequest: () => navigation,
        frame: () => MAIN,
      };
      for (const fn of listeners) fn(request);
    },
  };
  return page;
}

function hooks() {
  const allowed = [];
  const notes = [];
  return {
    allowed,
    notes,
    allow: (pattern) => allowed.push(pattern),
    note: (text) => notes.push(text),
    wait: async () => {},
    hidden: (line) => allowed.some((pattern) => pattern.test(line)),
  };
}

const CHUNK = "https://site.test/assets/messages-tr.js";

test("isNetworkFlap: the machine's own network errors, never the site's", () => {
  for (const flap of [
    "net::ERR_NETWORK_CHANGED",
    "net::ERR_INTERNET_DISCONNECTED",
    "net::ERR_QUIC_PROTOCOL_ERROR",
    "page.goto: net::ERR_NETWORK_CHANGED at https://x/",
  ])
    assert.equal(isNetworkFlap(flap), true, flap);
  for (const site of [
    "net::ERR_CONNECTION_REFUSED",
    "net::ERR_TIMED_OUT",
    "net::ERR_EMPTY_RESPONSE",
    "net::ERR_ABORTED",
    "Timeout 45000ms exceeded",
    "500",
  ])
    assert.equal(isNetworkFlap(site), false, site);
});

test("a sub-resource flap reloads the page, notes it, and keeps its line from the watcher", async () => {
  for (const error of [
    "net::ERR_NETWORK_CHANGED",
    "net::ERR_QUIC_PROTOCOL_ERROR",
    "net::ERR_INTERNET_DISCONNECTED",
  ]) {
    const page = fakePage();
    const h = hooks();
    const flaps = guardFlaps(page, h);
    page.fail(error, CHUNK);
    await flaps.settled();
    assert.equal(page.reloads, 1, error);
    assert.equal(h.hidden(`failed: ${error} GET site.test/assets/messages-tr.js`), true);
    assert.equal(h.hidden(`failed: ${error} GET site.test/assets/other.js`), false);
    assert.deepEqual(h.notes, [
      `ağ koptu (${error}, /assets/messages-tr.js): sayfa yeniden yüklendi (1/${FLAP_RELOADS})`,
    ]);
  }
});

test("the site's own failures are never retried and stay for the watcher", async () => {
  const page = fakePage();
  const h = hooks();
  const flaps = guardFlaps(page, h);
  for (const error of ["net::ERR_CONNECTION_REFUSED", "net::ERR_TIMED_OUT", "net::ERR_FAILED"])
    page.fail(error, CHUNK);
  await flaps.settled();
  assert.equal(page.reloads, 0);
  assert.deepEqual(h.allowed, []);
  assert.deepEqual(h.notes, []);
});

test("one flap that breaks several requests at once is one reload", async () => {
  const page = fakePage();
  const h = hooks();
  const flaps = guardFlaps(page, h);
  page.fail("net::ERR_NETWORK_CHANGED", CHUNK);
  page.fail("net::ERR_NETWORK_CHANGED", "https://site.test/assets/theme.js");
  page.fail("net::ERR_NETWORK_CHANGED", "https://site.test/rpc/me");
  await flaps.settled();
  assert.equal(page.reloads, 1);
  assert.equal(h.notes.length, 1);
  assert.equal(h.hidden("failed: net::ERR_NETWORK_CHANGED GET site.test/assets/theme.js"), true);
});

test("at most two reloads; the third flap is noted and fails the scenario", async () => {
  const page = fakePage();
  const h = hooks();
  const flaps = guardFlaps(page, h);
  // The same file each time: what an earlier retry let through must not hide the third.
  for (let i = 0; i < 2; i++) {
    page.fail("net::ERR_QUIC_PROTOCOL_ERROR", CHUNK);
    await flaps.settled();
  }
  page.fail("net::ERR_QUIC_PROTOCOL_ERROR", CHUNK);
  page.fail("net::ERR_QUIC_PROTOCOL_ERROR", CHUNK);
  await assert.rejects(
    flaps.settled(),
    /this machine's network flapped again after 2 reloads: failed: net::ERR_QUIC_PROTOCOL_ERROR GET site\.test\/assets\/messages-tr\.js/,
  );
  assert.equal(page.reloads, FLAP_RELOADS);
  assert.equal(FLAP_RELOADS, 2);
  assert.deepEqual(h.notes, [
    "ağ koptu (net::ERR_QUIC_PROTOCOL_ERROR, /assets/messages-tr.js): sayfa yeniden yüklendi (1/2)",
    "ağ koptu (net::ERR_QUIC_PROTOCOL_ERROR, /assets/messages-tr.js): sayfa yeniden yüklendi (2/2)",
    "ağ yine koptu (net::ERR_QUIC_PROTOCOL_ERROR, /assets/messages-tr.js): 2 yeniden yüklemeden sonra vazgeçildi",
  ]);
});

test("the document's own flap is page.goto's retry, noted, never a reload", async () => {
  const page = fakePage({ gotoFails: ["net::ERR_INTERNET_DISCONNECTED"] });
  const h = hooks();
  const flaps = guardFlaps(page, h);
  assert.equal(await page.goto("https://site.test/app"), "ok");
  await flaps.settled();
  assert.deepEqual(page.gotos, ["https://site.test/app", "https://site.test/app"]);
  assert.equal(page.reloads, 0);
  assert.equal(h.hidden("failed: net::ERR_INTERNET_DISCONNECTED GET site.test/app"), true);
  assert.deepEqual(h.notes, [
    "ağ koptu (net::ERR_INTERNET_DISCONNECTED): https://site.test/app açılışı yeniden denendi (1/2)",
  ]);
});

test("page.goto gives up after two retries and never retries a site error", async () => {
  const flapping = fakePage({
    gotoFails: ["net::ERR_NETWORK_CHANGED", "net::ERR_NETWORK_CHANGED", "net::ERR_NETWORK_CHANGED"],
  });
  guardFlaps(flapping, hooks());
  await assert.rejects(flapping.goto("https://site.test/app"), /ERR_NETWORK_CHANGED/);
  assert.equal(flapping.gotos.length, 3);

  const down = fakePage({ gotoFails: ["net::ERR_CONNECTION_REFUSED"] });
  const h = hooks();
  guardFlaps(down, h);
  await assert.rejects(down.goto("https://site.test/app"), /ERR_CONNECTION_REFUSED/);
  assert.equal(down.gotos.length, 1);
  assert.deepEqual(h.allowed, []);
  assert.deepEqual(h.notes, []);
});
