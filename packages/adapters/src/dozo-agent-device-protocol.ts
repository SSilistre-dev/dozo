import { z } from "zod";

/**
 * Agent mode on the person's own computer, over its device connection: the desktop app runs the
 * agent, and its sign-in, there. The server names only which agent (an id the app looks up in its
 * own fixed catalog, with the program and arguments it starts) and sends what a turn needs: the
 * bot's instructions, the conversation, the bot's tools and their results. It never sends a
 * program, an argument, a folder or an answer to the agent's own permission requests: the app asks
 * the person for those on the computer itself, and only tells the server it is waiting.
 */

/** How much one request or frame may carry, in characters. */
export const AGENT_DEVICE_LIMITS = {
  instructions: 512 * 1024,
  input: 2 * 1024 * 1024,
  /** The bot's tools as one JSON text: names, descriptions and input schemas. */
  tools: 1024 * 1024,
  toolCount: 256,
  toolResult: 1024 * 1024,
  text: 64 * 1024,
  /** The arguments of one tool call the agent makes, as one JSON text. */
  toolArgs: 256 * 1024,
  line: 1024,
  message: 4096,
} as const;

/** A whole agent turn: the server lets its stream run this long before it gives up. */
export const AGENT_TURN_DEADLINE_MS = 60 * 60_000;

const ids = { botId: z.string().min(1).max(256), runId: z.string().min(1).max(256) };
/** Which agent of the app's catalog; nothing about how it is started. */
const agentId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const callId = z.string().min(1).max(64);
const line = z.string().max(AGENT_DEVICE_LIMITS.line);

/**
 * One of the bot's tools as the agent sees it. Strict, like every object here: a field the schema
 * does not name is refused, so nothing more reaches the computer than what is checked.
 */
const agentTool = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  description: z.string().max(16 * 1024),
  inputSchema: z.record(z.string(), z.unknown()),
});

/**
 * Starts the run's turn, or goes on with it after a bot tool waited for the person: the app keeps
 * one agent session per run and refuses a run it saw before and no longer has (`failed`), so an
 * interrupted run is never started again. Strict: a request that carries anything more (a program,
 * its arguments, a folder) is refused, not stripped.
 */
export const agentTurnRequest = z.strictObject({
  ...ids,
  method: z.literal("agentTurn"),
  agent: agentId,
  /**
   * A model id the agent takes as a protocol field. Even so it could never read as an argument or
   * a path: it starts with a letter or digit and holds no `..` and no `/` (no agent's ids need one).
   */
  model: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    .refine((model) => !model.includes(".."), { message: "model id holds .." })
    .optional(),
  instructions: z.string().max(AGENT_DEVICE_LIMITS.instructions),
  input: z.string().min(1).max(AGENT_DEVICE_LIMITS.input),
  tools: z
    .array(agentTool)
    .max(AGENT_DEVICE_LIMITS.toolCount)
    .refine((tools) => JSON.stringify(tools).length <= AGENT_DEVICE_LIMITS.tools, {
      message: "tools too large",
    }),
});

/** The result of one bot tool the agent called (`toolCall`), for the turn that waits on it. */
export const agentToolResultRequest = z.strictObject({
  ...ids,
  method: z.literal("agentToolResult"),
  callId,
  text: z.string().max(AGENT_DEVICE_LIMITS.toolResult),
  isError: z.boolean(),
});

/** Ends the run's agent session: its process, what it started and its folder. */
export const agentStopRequest = z.strictObject({ ...ids, method: z.literal("agentStop") });

/**
 * What the app sends while a turn runs: one value per frame; `done` and `failed` end the turn.
 * Each is strict and bounded, so a computer cannot send the server more than it reads.
 */
export const agentTurnFrame = z.discriminatedUnion("type", [
  /** The agent is running: before this, nothing of the turn happened on the computer. */
  z.strictObject({ type: z.literal("started") }),
  z.strictObject({ type: z.literal("text"), text: z.string().max(AGENT_DEVICE_LIMITS.text) }),
  /** Something the agent did on its own, for the run's progress line. */
  z.strictObject({ type: z.literal("activity"), text: line }),
  /** The agent calls one of the bot's tools: answered with `agentToolResult`. */
  z.strictObject({
    type: z.literal("toolCall"),
    callId,
    name: agentTool.shape.name,
    args: z
      .record(z.string(), z.unknown())
      .refine((args) => JSON.stringify(args).length <= AGENT_DEVICE_LIMITS.toolArgs, {
        message: "tool arguments too large",
      }),
  }),
  /** The agent asks the person, on the computer, before it goes on. */
  z.strictObject({ type: z.literal("approvalWaiting"), summary: line }),
  /** Nobody answered on the computer in time: the agent was told no. */
  z.strictObject({ type: z.literal("approvalExpired"), summary: line }),
  /** The account's usage ran out, with when it opens again (epoch ms) when the agent said. */
  z.strictObject({ type: z.literal("limit"), resetsAt: z.number().int().positive().optional() }),
  z.strictObject({ type: z.literal("done") }),
  z.strictObject({
    type: z.literal("failed"),
    message: z.string().max(AGENT_DEVICE_LIMITS.message),
  }),
]);
export type AgentTurnFrame = z.infer<typeof agentTurnFrame>;
