import { describe, expect, it } from "vitest";
import { RelayRequest, RelayResponse, RelayUnsupportedBodyError } from "./dozo-relay-web";

async function read(stream: ReadableStream<Uint8Array> | null) {
  return new Response(stream).text();
}

describe("RelayRequest", () => {
  it("streams each body kind the app sends, with the type it implies", async () => {
    const text = new RelayRequest("https://x.invalid/a", { method: "post", body: "hi" });
    expect(text.method).toBe("POST");
    expect(text.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    expect(await read(text.body)).toBe("hi");

    const form = new RelayRequest("https://x.invalid/a", {
      method: "POST",
      body: new URLSearchParams({ a: "1" }),
    });
    expect(form.headers.get("content-type")).toContain("x-www-form-urlencoded");
    expect(await read(form.body)).toBe("a=1");

    const typed = new RelayRequest("https://x.invalid/a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(typed.headers.get("content-type")).toBe("application/json");

    const buffer = new RelayRequest("https://x.invalid/a", {
      method: "POST",
      body: new TextEncoder().encode("ab").buffer,
    });
    expect(await read(buffer.body)).toBe("ab");
    const view = new RelayRequest("https://x.invalid/a", {
      method: "POST",
      body: new TextEncoder().encode("xabx").subarray(1, 3),
    });
    expect(await read(view.body)).toBe("ab");
    const empty = new RelayRequest("https://x.invalid/a", { method: "POST", body: "" });
    expect(await read(empty.body)).toBe("");

    const stream = new Response("s").body as ReadableStream<Uint8Array>;
    expect(new RelayRequest("https://x.invalid/a", { method: "POST", body: stream }).body).toBe(
      stream,
    );
  });

  it("has no body, a GET method and its own signal by default", () => {
    const request = new RelayRequest("https://x.invalid/a");
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
    expect(request.signal.aborted).toBe(false);
    const controller = new AbortController();
    expect(new RelayRequest("https://x.invalid/a", { signal: controller.signal }).signal).toBe(
      controller.signal,
    );
  });

  it("refuses a body on GET and a body the relay cannot carry", () => {
    expect(() => new RelayRequest("https://x.invalid/a", { body: "x" })).toThrow(TypeError);
    expect(
      () => new RelayRequest("https://x.invalid/a", { method: "POST", body: new FormData() }),
    ).toThrow(RelayUnsupportedBodyError);
  });
});

describe("RelayResponse", () => {
  const body = (text: string) => new Response(text).body as ReadableStream<Uint8Array>;

  it("reads its body once, as text, JSON, bytes or a buffer", async () => {
    const response = new RelayResponse(body('{"a":1}'), {
      status: 201,
      statusText: "Created",
      headers: [["x-a", "b"]],
    });
    expect(response.ok).toBe(true);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-a")).toBe("b");
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toEqual({ a: 1 });
    expect(response.bodyUsed).toBe(true);
    await expect(response.text()).rejects.toThrow("already read");
    expect(new Uint8Array(await new RelayResponse(body("ab")).arrayBuffer())).toEqual(
      new TextEncoder().encode("ab"),
    );
    expect(await new RelayResponse(null, { status: 204 }).text()).toBe("");
  });

  it("keeps its stream for a reader and copies itself for a second reader", async () => {
    const response = new RelayResponse(body("twice"), { status: 404 });
    expect(response.ok).toBe(false);
    const copy = response.clone();
    expect(await copy.text()).toBe("twice");
    expect(await read(response.body)).toBe("twice");
    expect(new RelayResponse(null).clone().body).toBeNull();
    const used = new RelayResponse(body("x"));
    await used.text();
    expect(() => used.clone()).toThrow("already read");
  });

  it("refuses a status outside 200 to 599, and the readers the relay cannot serve", async () => {
    expect(() => new RelayResponse(null, { status: 101 })).toThrow(RangeError);
    expect(() => new RelayResponse(null, { status: 600 })).toThrow(RangeError);
    await expect(new RelayResponse(null).blob()).rejects.toBeInstanceOf(RelayUnsupportedBodyError);
    await expect(new RelayResponse(null).formData()).rejects.toBeInstanceOf(
      RelayUnsupportedBodyError,
    );
  });
});
