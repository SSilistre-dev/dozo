/** The longest one-time wait: a week. Longer waits are a recurring routine's job. */
export const DOZO_WAIT_MAX_MINUTES = 7 * 24 * 60;
/** No shorter than one change check, the shortest interval a watch has. */
export const DOZO_WAIT_MIN_MINUTES = 5;

const waitMinutesSpec = {
  type: "number",
  minimum: DOZO_WAIT_MIN_MINUTES,
  maximum: DOZO_WAIT_MAX_MINUTES,
  description: `Make this watch a one-time wait: no model runs while it waits, and you are woken once, in this chat, when the watched thing first changes or after this many minutes without a change (${DOZO_WAIT_MIN_MINUTES} to ${DOZO_WAIT_MAX_MINUTES}); then the watch ends. Use it to wait for a file, a page or a command's output before you continue, then end your turn. The prompt must say what to do in both cases.`,
};

/** Model serializers send unused optional fields as null or ""; on other timings that is no wait. */
const blankWaitMinutes = {
  anyOf: [{ type: "null" }, { type: "string", pattern: "^\\s*$" }],
};

type Branch = { properties: Record<string, unknown> };

/**
 * schedule_create's input with `waitMinutes` on its watch branch, the only timing a wait takes.
 * The other branches accept it only as null, so a timed one-shot stays the way to wait a while.
 */
export function dozoWaitInputSchema<Schema extends { oneOf: Branch[] }>(schema: Schema): Schema {
  return {
    ...schema,
    oneOf: schema.oneOf.map((branch) => {
      const watch = (branch.properties.watch as { type?: string } | undefined)?.type === "object";
      return {
        ...branch,
        properties: {
          ...branch.properties,
          waitMinutes: watch ? waitMinutesSpec : blankWaitMinutes,
        },
      };
    }),
  };
}
