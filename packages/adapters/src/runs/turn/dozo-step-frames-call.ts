import { noteScreenshot } from "./dozo-step-frames.js";
import { onToolCalled as upstreamOnToolCalled } from "./run-turn-tools.js";

/** Notes the screenshot the reply's last call took before the next call starts. */
export async function onToolCalled(...args: Parameters<typeof upstreamOnToolCalled>) {
  noteScreenshot(args[0]);
  return upstreamOnToolCalled(...args);
}
