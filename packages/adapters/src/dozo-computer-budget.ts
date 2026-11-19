import { COMPUTERS_BUSY_MESSAGE, PLAN_LIMIT_CODES } from "@rakazo/contracts";
import { ClientError, deadlineSignal, resolveSupervisorToken } from "@rakazo/core";

export { COMPUTERS_BUSY_MESSAGE };
export const COMPUTERS_BUSY_CODE = PLAN_LIMIT_CODES.computersBusy;

/** The supervisor's refusal text. The supervisor keeps its own copy; a test in each holds the line. */
const SUPERVISOR_BUDGET_FULL = "Computer memory budget reached";

const SUPERVISOR_DEFAULT_URL = "http://127.0.0.1:7091";
const READ_DEADLINE_MS = 3_000;
const GB = 1024 ** 3;

/** A start the host's memory budget refused: nothing started, so nothing was used or charged. */
export class ComputerCapacityError extends ClientError {
  constructor() {
    super("TOO_MANY_REQUESTS", COMPUTERS_BUSY_MESSAGE, COMPUTERS_BUSY_CODE);
    this.name = "ComputerCapacityError";
  }
}

export function throwIfComputersBusy(status: number, detail: string): void {
  if (status === 429 && detail.includes(SUPERVISOR_BUDGET_FULL)) throw new ComputerCapacityError();
}

/**
 * What the running computers hold together against the total the operator set, from the
 * supervisor (it asks Docker). Undefined where no total is set.
 */
export async function hostComputerMemory(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<{ usedGb: number; totalGb: number } | undefined> {
  const base = (env.SANDBOX_SUPERVISOR_URL ?? SUPERVISOR_DEFAULT_URL).replace(/\/$/, "");
  const res = await fetchFn(`${base}/computer-memory`, {
    headers: { authorization: `Bearer ${resolveSupervisorToken(env)}` },
    signal: deadlineSignal(READ_DEADLINE_MS),
  });
  if (!res.ok) throw new Error(`computer memory read failed: ${res.status}`);
  const body = (await res.json()) as { usedBytes: number; budgetBytes?: number };
  if (body.budgetBytes === undefined) return undefined;
  return { usedGb: body.usedBytes / GB, totalGb: body.budgetBytes / GB };
}
