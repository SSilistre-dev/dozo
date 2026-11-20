import type { RelayDuplex, RelayReceiver } from "./dozo-relay-channel.js";

export type RelayPipeEnd = "app" | "host";

/**
 * Two connected duplexes standing in for a relay: what one end sends reaches the other in order,
 * a microtask later. `log` keeps every message that crossed, as the relay would see it; `tap` may
 * change, drop, duplicate or reorder what crosses.
 */
export function relayPipe() {
  const log: { from: RelayPipeEnd; data: Uint8Array }[] = [];
  const pipe = {
    log,
    tap: (_from: RelayPipeEnd, data: Uint8Array): Uint8Array[] => [data],
    closedWith: null as Error | null,
    app: null as unknown as RelayDuplex,
    host: null as unknown as RelayDuplex,
  };
  const receivers: Record<RelayPipeEnd, RelayReceiver | null> = { app: null, host: null };
  const pending: Record<RelayPipeEnd, Uint8Array[]> = { app: [], host: [] };

  // Messages already on the way still arrive after a close, as on a real socket.
  const deliver = (to: RelayPipeEnd, data: Uint8Array) => {
    const receiver = receivers[to];
    if (receiver) receiver.receive(data);
    else pending[to].push(data);
  };
  const end = (name: RelayPipeEnd): RelayDuplex => {
    const other: RelayPipeEnd = name === "app" ? "host" : "app";
    return {
      send(data) {
        if (pipe.closedWith) return;
        log.push({ from: name, data: data.slice() });
        for (const out of pipe.tap(name, data.slice())) queueMicrotask(() => deliver(other, out));
      },
      close(reason) {
        if (pipe.closedWith) return;
        const error = new Error(reason);
        pipe.closedWith = error;
        queueMicrotask(() => {
          receivers.app?.closed(error);
          receivers.host?.closed(error);
        });
      },
      attach(receiver) {
        receivers[name] = receiver;
        for (const data of pending[name].splice(0)) receiver.receive(data);
      },
    };
  };
  pipe.app = end("app");
  pipe.host = end("host");
  return pipe;
}

/** Whether `needle` appears anywhere in `haystack`. */
export function containsBytes(haystack: Uint8Array, needle: Uint8Array) {
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}
