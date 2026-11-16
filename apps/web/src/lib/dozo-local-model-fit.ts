// Offline estimate of which open-weight models run on a given machine fast
// enough. Pure functions only: the data lives in dozo-local-model-catalog.ts.

export type HardwareEntry = {
  id: string;
  label: string;
  kind: "unified" | "gpu";
  match: RegExp;
  bandwidthGBps: number;
  memoryGB: readonly number[];
  source: string;
};

export type LocalRuntime = {
  label: string;
  baseUrl: string;
  /**
   * The shell line that makes the model available at the given context, and the id to connect:
   * the context belongs to that model, not to however the runtime's server was started.
   */
  prepare: (tag: string, contextTokens: number) => { command: string; modelId: string };
};

export type LocalModelEntry = {
  id: string;
  label: string;
  tag: string;
  licence: "Apache-2.0" | "MIT";
  paramsB: number;
  activeParamsB?: number;
  weightsGB: number;
  kvGBPer8k: number;
  thinking: boolean;
  source: string;
  verifiedOn: string;
  toolCallCheckedOn: string;
};

export type HardwareProfile = {
  kind: "unified" | "gpu";
  usableMemoryGB: number;
  bandwidthGBps: number;
  source: "detected" | "chosen";
};

export type FitTier = "comfortable" | "usable" | "slow" | "no-fit";

export type LocalModelFit = {
  model: LocalModelEntry;
  tier: FitTier;
  tokensPerSecond: number;
  memoryGB: number;
};

export const LOCAL_MODEL_CONTEXT_TOKENS = 32768;

// Share of the chosen memory a model may take. Unified memory is also the
// operating system's and the browser's; a discrete card's memory is not.
const USABLE_MEMORY_SHARE = { unified: 0.75, gpu: 0.9 } as const;

// Memory the runtime itself needs on top of weights and the KV cache.
const RUNTIME_OVERHEAD_GB = 1;

// Free memory that must remain beyond what the model needs, so a borderline
// model is not promised: it fits only when needed + headroom <= usable.
const FIT_HEADROOM_GB = 1;

// Prudence factor for mixture-of-experts models (entries with `activeParamsB`).
// There is no calibration row behind it: the llama.cpp measurements below are
// all dense models, so the active-weights estimate is unchecked for these and
// came out high (about 105 tok/s for one entry). 0.75 is a conservative cut,
// not a measured figure.
const MOE_PRUDENCE_FACTOR = 0.75;

// Share of the theoretical memory bandwidth that token generation reaches.
// Basis: llama.cpp benchmark threads, Llama 2 7B Q4_0 (about 3.8 GB), where
// measured speed divided by bandwidth over file size ranged 0.52 to 0.84 on
// Apple chips and 0.62 to 0.85 on NVIDIA cards (see the calibration rows in
// dozo-local-model-fit.test.ts). 0.55 put three Apple rows 31 to 34 percent
// under the measurement, so the Apple figure was raised to 0.65. The card
// figure stays at its starting value: its worst row is 29 percent under.
const BANDWIDTH_EFFICIENCY = { unified: 0.65, gpu: 0.6 } as const;

// Quoted speeds are cut by a fifth so the promise holds on a busy machine.
const SAFETY_FACTOR = 0.8;

const SPEED_STEP = 5;

// Speed tiers: at least this many tokens per second is usable, and comfortable above the next.
const MIN_TPS = 25;
const COMFORTABLE_TPS = 50;

const TIER_ORDER: readonly FitTier[] = ["comfortable", "usable", "slow", "no-fit"];

export function matchHardware(
  renderer: string | null,
  table: readonly HardwareEntry[],
): HardwareEntry | null {
  if (!renderer) return null;
  let best: HardwareEntry | null = null;
  let bestLength = 0;
  for (const entry of table) {
    const found = renderer.match(entry.match);
    // The longest matched text is the most specific entry.
    if (found && found[0].length > bestLength) {
      best = entry;
      bestLength = found[0].length;
    }
  }
  return best;
}

export function hardwareProfile(
  entry: HardwareEntry,
  memoryGB: number,
  source: HardwareProfile["source"],
): HardwareProfile {
  return {
    kind: entry.kind,
    usableMemoryGB: memoryGB * USABLE_MEMORY_SHARE[entry.kind],
    bandwidthGBps: entry.bandwidthGBps,
    source,
  };
}

// Tokens per second before the safety factor and the rounding: every token
// reads the active weights once, so speed is bandwidth over the bytes read.
export function rawTokensPerSecond(
  kind: "unified" | "gpu",
  bandwidthGBps: number,
  model: Pick<LocalModelEntry, "weightsGB" | "paramsB" | "activeParamsB">,
): number {
  const activeShare = (model.activeParamsB ?? model.paramsB) / model.paramsB;
  const prudence = model.activeParamsB === undefined ? 1 : MOE_PRUDENCE_FACTOR;
  return (bandwidthGBps / (model.weightsGB * activeShare)) * BANDWIDTH_EFFICIENCY[kind] * prudence;
}

export function memoryNeededGB(
  model: Pick<LocalModelEntry, "weightsGB" | "kvGBPer8k">,
  contextTokens: number,
): number {
  return model.weightsGB + model.kvGBPer8k * (contextTokens / 8192) + RUNTIME_OVERHEAD_GB;
}

function roundDownToStep(value: number): number {
  // The small term keeps a value that is exactly on a step from falling
  // below it through floating point error.
  return Math.floor(value / SPEED_STEP + 1e-9) * SPEED_STEP;
}

function fitModel(profile: HardwareProfile, model: LocalModelEntry): LocalModelFit {
  const memoryGB = memoryNeededGB(model, LOCAL_MODEL_CONTEXT_TOKENS);
  // Partial offload collapses speed, so a model that does not fit whole is
  // never given a speed.
  if (memoryGB + FIT_HEADROOM_GB > profile.usableMemoryGB) {
    return { model, tier: "no-fit", tokensPerSecond: 0, memoryGB };
  }
  const tokensPerSecond = roundDownToStep(
    rawTokensPerSecond(profile.kind, profile.bandwidthGBps, model) * SAFETY_FACTOR,
  );
  const tier: FitTier =
    tokensPerSecond >= COMFORTABLE_TPS
      ? "comfortable"
      : tokensPerSecond >= MIN_TPS
        ? "usable"
        : "slow";
  return { model, tier, tokensPerSecond, memoryGB };
}

export function rankLocalModels(
  profile: HardwareProfile,
  catalog: readonly LocalModelEntry[],
): LocalModelFit[] {
  return catalog
    .map((model) => fitModel(profile, model))
    .sort(
      (a, b) =>
        TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
        Number(a.model.thinking) - Number(b.model.thinking) ||
        b.model.paramsB - a.model.paramsB,
    );
}
