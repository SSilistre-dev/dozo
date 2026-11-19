import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMMUTABLE_ASSET, missingAssetMiddleware } from "./dozo-missing-asset";
import { createWebServer } from "./standalone-server.js";

const assetsDir = path.resolve("/srv/dist/assets");
const present = new Set([path.join(assetsDir, "index-new.js")]);

function request(url: string) {
  const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
  const next = vi.fn();
  missingAssetMiddleware(assetsDir, "/assets/", null, (file) => present.has(file))(
    { url, method: "GET" } as IncomingMessage,
    res as unknown as ServerResponse,
    next,
  );
  return { res, next };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function standalone() {
  const root = await mkdtemp(path.join(tmpdir(), "dozo-asset-cache-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist", "assets"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), "<!doctype html><title>app</title>");
  await writeFile(path.join(root, "dist", "sw.js"), "self;");
  await writeFile(path.join(root, "dist", "assets", "app-1.js"), "export {};");
  await writeFile(path.join(root, "dist", "build-id"), "test\n");
  const server = createWebServer(root, {
    API_PROXY_TARGET: "http://127.0.0.1:9",
    RAKAZO_HOST: "app.example.test",
    SCREEN_PROXY_SECRET: "test-screen-proxy-secret-0123456789abcdef",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return (pathname: string, headers: http.OutgoingHttpHeaders = {}) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port,
            path: pathname,
            headers: { host: "app.example.test", ...headers },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response));
          },
        )
        .on("error", reject);
    });
}

describe("hashed asset cache", () => {
  it("marks an asset of the current build immutable and leaves other paths alone", () => {
    const asset = request("/assets/index-new.js");
    expect(asset.next).toHaveBeenCalled();
    expect(asset.res.setHeader).toHaveBeenCalledWith("cache-control", IMMUTABLE_ASSET);
    const page = request("/app/settings");
    expect(page.next).toHaveBeenCalled();
    expect(page.res.setHeader).not.toHaveBeenCalled();
  });

  it("never marks a missing asset's 404 cacheable", () => {
    const { res, next } = request("/assets/index-old.js");
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.setHeader).toHaveBeenCalledWith("cache-control", "no-store");
    expect(res.setHeader).not.toHaveBeenCalledWith("cache-control", IMMUTABLE_ASSET);
  });

  it("is what the standalone server sends, while the shell and the worker stay no-cache", async () => {
    const get = await standalone();
    const asset = await get("/assets/app-1.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe(IMMUTABLE_ASSET);
    const revalidated = await get("/assets/app-1.js", { "if-none-match": asset.headers.etag });
    expect(revalidated.statusCode).toBe(304);
    expect((await get("/")).headers["cache-control"]).toBe("no-cache");
    expect((await get("/sw.js")).headers["cache-control"]).toBe("no-cache");
    expect((await get("/assets/gone.js")).headers["cache-control"]).toBe("no-store");
  });
});
