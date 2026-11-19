import type { Page, Request } from "@playwright/test";

/**
 * What a page asked for and has not finished, and what failed: the line a report needs when a load
 * stalls. Long-lived streams (the live notifications) are always open and are listed too.
 */
export function watchLoad(page: Page) {
  const open = new Map<Request, number>();
  const failed: string[] = [];
  const name = (request: Request) => {
    const url = new URL(request.url());
    return `${request.method()} ${url.host}${url.pathname}`;
  };
  page.on("request", (request) => open.set(request, Date.now()));
  page.on("requestfinished", (request) => open.delete(request));
  page.on("requestfailed", (request) => {
    open.delete(request);
    failed.push(`${name(request)} (${request.failure()?.errorText ?? "failed"})`);
  });
  return {
    report(): string {
      const now = Date.now();
      const waiting = [...open].map(([request, at]) => `${name(request)} (${now - at} ms)`);
      return `unfinished: ${waiting.join(", ") || "none"}; failed: ${failed.join(", ") || "none"}`;
    },
  };
}
