import { describe, expect, it } from "vitest";
import type { HardwareEntry, HardwareProfile, LocalModelEntry } from "./dozo-local-model-fit";
import {
  hardwareProfile,
  LOCAL_MODEL_CONTEXT_TOKENS,
  matchHardware,
  memoryNeededGB,
  rankLocalModels,
  rawTokensPerSecond,
} from "./dozo-local-model-fit";

function model(overrides: Partial<LocalModelEntry> = {}): LocalModelEntry {
  return {
    id: "m",
    label: "M",
    tag: "m:1b",
    licence: "Apache-2.0",
    paramsB: 10,
    weightsGB: 10,
    kvGBPer8k: 0,
    thinking: false,
    source: "https://example.com/m",
    verifiedOn: "2026-11-16",
    toolCallCheckedOn: "",
    ...overrides,
  };
}

function profile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    kind: "unified",
    usableMemoryGB: 100,
    bandwidthGBps: 500,
    source: "chosen",
    ...overrides,
  };
}

function entry(id: string, match: RegExp, overrides: Partial<HardwareEntry> = {}): HardwareEntry {
  return {
    id,
    label: id,
    kind: "gpu",
    match,
    bandwidthGBps: 100,
    memoryGB: [8],
    source: "https://example.com/hardware",
    ...overrides,
  };
}

// Measured generation speed of Llama 2 7B Q4_0, from the llama.cpp benchmark
// threads. The file is listed there as 3.56 GiB, which is 3.822 GB.
// Apple: https://github.com/ggml-org/llama.cpp/discussions/4167
// CUDA:  https://github.com/ggml-org/llama.cpp/discussions/15013 (tg128, no FA)
// Bandwidth is the lowest variant of each chip except where `note` says the
// measured chip had more.
const LLAMA_7B_Q4_0 = { weightsGB: 3.56 * 1.073741824, paramsB: 7 };
const TOLERANCE = 0.3;

const CALIBRATION: readonly {
  name: string;
  kind: "unified" | "gpu";
  bandwidthGBps: number;
  measured: number;
  note?: string;
}[] = [
  { name: "M1", kind: "unified", bandwidthGBps: 68, measured: 14.19 },
  { name: "M1 Pro", kind: "unified", bandwidthGBps: 200, measured: 35.52 },
  { name: "M1 Max", kind: "unified", bandwidthGBps: 400, measured: 54.61 },
  { name: "M2", kind: "unified", bandwidthGBps: 100, measured: 21.7 },
  { name: "M4", kind: "unified", bandwidthGBps: 120, measured: 24.11 },
  { name: "M4 Pro", kind: "unified", bandwidthGBps: 273, measured: 49.64 },
  { name: "M4 Max", kind: "unified", bandwidthGBps: 410, measured: 69.95 },
  { name: "M5 Pro", kind: "unified", bandwidthGBps: 307, measured: 66.33 },
  {
    name: "M5 Max",
    kind: "unified",
    bandwidthGBps: 614,
    measured: 119.92,
    note: "measured on the 40-core variant",
  },
  { name: "RTX 5090", kind: "gpu", bandwidthGBps: 1792, measured: 290.02 },
  { name: "RTX 4090", kind: "gpu", bandwidthGBps: 1008, measured: 186.21 },
  { name: "RTX 5080", kind: "gpu", bandwidthGBps: 960, measured: 181.99 },
  { name: "RTX 5070 Ti", kind: "gpu", bandwidthGBps: 896, measured: 176.85 },
  { name: "RTX 3090", kind: "gpu", bandwidthGBps: 936, measured: 158.16 },
  { name: "RTX 5070", kind: "gpu", bandwidthGBps: 672, measured: 127.54 },
  { name: "RTX 4060 Ti", kind: "gpu", bandwidthGBps: 288, measured: 63.86 },
];

describe("raw estimate against published speeds", () => {
  it.each(CALIBRATION)("$name is within 30% of the measurement", (row) => {
    const estimate = rawTokensPerSecond(row.kind, row.bandwidthGBps, LLAMA_7B_Q4_0);
    expect(Math.abs(estimate - row.measured) / row.measured).toBeLessThanOrEqual(TOLERANCE);
  });
});

describe("memory", () => {
  it("is weights plus the cache for the context plus one gigabyte", () => {
    const m = model({ weightsGB: 10, kvGBPer8k: 0.5 });
    expect(memoryNeededGB(m, 32768)).toBeCloseTo(10 + 0.5 * 4 + 1, 9);
    expect(LOCAL_MODEL_CONTEXT_TOKENS).toBe(32768);
  });

  it("takes 75% of unified memory and 90% of card memory", () => {
    const unified = entry("u", /u/, { kind: "unified", bandwidthGBps: 400 });
    const gpu = entry("g", /g/, { kind: "gpu", bandwidthGBps: 900 });
    expect(hardwareProfile(unified, 64, "chosen")).toEqual({
      kind: "unified",
      usableMemoryGB: 48,
      bandwidthGBps: 400,
      source: "chosen",
    });
    expect(hardwareProfile(gpu, 24, "detected")).toEqual({
      kind: "gpu",
      usableMemoryGB: 21.6,
      bandwidthGBps: 900,
      source: "detected",
    });
  });

  it("is no-fit when the model needs more than the usable memory", () => {
    // Needs 10 + 1 = 11 GB.
    const [tight] = rankLocalModels(profile({ usableMemoryGB: 10.9 }), [model()]);
    expect(tight?.tier).toBe("no-fit");
    expect(tight?.tokensPerSecond).toBe(0);
    expect(tight?.memoryGB).toBeCloseTo(11, 9);
  });

  it("keeps one gigabyte of headroom beyond what the model needs", () => {
    // Needs 11 GB, so 12 GB is the least that fits; a 24 GB card has 21.6 usable,
    // which does not hold a model that needs 21.51.
    const [exact] = rankLocalModels(profile({ usableMemoryGB: 12 }), [model()]);
    expect(exact?.tier).not.toBe("no-fit");
    const [short] = rankLocalModels(profile({ usableMemoryGB: 11.99 }), [model()]);
    expect(short?.tier).toBe("no-fit");
    const [border] = rankLocalModels(profile({ usableMemoryGB: 21.6 }), [
      model({ weightsGB: 20.51 }),
    ]);
    expect(border?.memoryGB).toBeCloseTo(21.51, 9);
    expect(border?.tier).toBe("no-fit");
  });

  it("counts the cache of the fixed context", () => {
    const m = model({ kvGBPer8k: 1 });
    const [fit] = rankLocalModels(profile(), [m]);
    expect(fit?.memoryGB).toBeCloseTo(memoryNeededGB(m, LOCAL_MODEL_CONTEXT_TOKENS), 9);
    // 10 weights + 1 per 8k tokens of context + 1 runtime.
    expect(fit?.memoryGB).toBeCloseTo(10 + LOCAL_MODEL_CONTEXT_TOKENS / 8192 + 1, 9);
  });
});

describe("speed", () => {
  it("applies the efficiency, the 0.8 factor and rounds down to 5", () => {
    // 500 / 10 * 0.65 * 0.8 = 26 -> 25.
    const [fit] = rankLocalModels(profile(), [model()]);
    expect(fit?.tokensPerSecond).toBe(25);
    // 536.5385 / 10 * 0.52 = 27.9 -> 25, not 30.
    const [high] = rankLocalModels(profile({ bandwidthGBps: 536.5385 }), [model()]);
    expect(high?.tokensPerSecond).toBe(25);
    // 576.9231 / 10 * 0.52 = 30.0 -> 30.
    const [step] = rankLocalModels(profile({ bandwidthGBps: 576.9231 }), [model()]);
    expect(step?.tokensPerSecond).toBe(30);
  });

  it("uses the active parameters for speed and the total for memory", () => {
    const moe = model({
      paramsB: 20,
      activeParamsB: 4,
      weightsGB: 12,
      kvGBPer8k: 0.5,
    });
    const dense = model({ paramsB: 20, weightsGB: 12, kvGBPer8k: 0.5 });
    const p = profile({ bandwidthGBps: 200 });
    const [fastFit] = rankLocalModels(p, [moe]);
    const [denseFit] = rankLocalModels(p, [dense]);
    // 200 / (12 * 4 / 20) * 0.65 * 0.75 * 0.8 = 32.5 -> 30; dense 200 / 12 * 0.52 = 8.7 -> 5.
    expect(fastFit?.tokensPerSecond).toBe(30);
    expect(denseFit?.tokensPerSecond).toBe(5);
    expect(fastFit?.memoryGB).toBeCloseTo(denseFit?.memoryGB ?? 0, 9);
    expect(fastFit?.memoryGB).toBeCloseTo(12 + 0.5 * 4 + 1, 9);
  });

  it("cuts the speed of a mixture-of-experts model by a quarter", () => {
    const moe = { weightsGB: 12, paramsB: 20, activeParamsB: 4 };
    const dense = { weightsGB: 12 * (4 / 20), paramsB: 20 };
    // Same bytes read per token; only the prudence factor differs.
    const plain = rawTokensPerSecond("unified", 200, dense);
    expect(rawTokensPerSecond("unified", 200, moe)).toBeCloseTo(plain * 0.75, 9);
    // 200 / 2.4 * 0.65 = 54.2 would quote 40 tok/s; with the factor it is 32.5 -> 30.
    const [fit] = rankLocalModels(profile({ bandwidthGBps: 200 }), [model(moe)]);
    expect(fit?.tokensPerSecond).toBe(30);
  });

  it("uses the card efficiency for a gpu", () => {
    // 100 / 1.92 * 0.6 * 0.8 = 25.
    const [fit] = rankLocalModels(profile({ kind: "gpu", bandwidthGBps: 100 }), [
      model({ weightsGB: 1.92 }),
    ]);
    expect(fit?.tokensPerSecond).toBe(25);
  });
});

describe("tiers", () => {
  const m = model({ weightsGB: 1.92 });
  const gpu = (bandwidthGBps: number) => profile({ kind: "gpu", bandwidthGBps });

  it("switches to usable at exactly 25 and not below", () => {
    expect(rankLocalModels(gpu(100), [m])[0]?.tier).toBe("usable");
    const below = rankLocalModels(gpu(99.9), [m])[0];
    expect(below?.tokensPerSecond).toBe(20);
    expect(below?.tier).toBe("slow");
  });

  it("switches to comfortable at exactly 50 and not below", () => {
    const atFifty = rankLocalModels(gpu(200), [m])[0];
    expect(atFifty?.tokensPerSecond).toBe(50);
    expect(atFifty?.tier).toBe("comfortable");
    const below = rankLocalModels(gpu(199.9), [m])[0];
    expect(below?.tokensPerSecond).toBe(45);
    expect(below?.tier).toBe("usable");
  });

  it("never rates a cpu as usable or comfortable", () => {
    const cpu = profile({ kind: "cpu", bandwidthGBps: 100000 });
    const fits = rankLocalModels(cpu, [model({ weightsGB: 1 })]);
    expect(fits[0]?.tier).toBe("slow");
    expect(fits[0]?.tokensPerSecond).toBe(0);
    const none = rankLocalModels(profile({ kind: "cpu", usableMemoryGB: 4 }), [model()]);
    expect(none[0]?.tier).toBe("no-fit");
  });
});

describe("order", () => {
  it("lists tiers best first, plain before thinking, then larger first", () => {
    // Speed scales with 1 / weights, so weights pick the tier here.
    const catalog = [
      model({ id: "slow-big", paramsB: 30, weightsGB: 60 }),
      model({ id: "fast-thinking", paramsB: 30, weightsGB: 2, thinking: true }),
      model({ id: "fast-small", paramsB: 4, weightsGB: 2 }),
      model({ id: "fast-large", paramsB: 8, weightsGB: 2 }),
      model({ id: "never", paramsB: 70, weightsGB: 500 }),
      model({ id: "mid", paramsB: 12, weightsGB: 4 }),
      model({ id: "slow-small", paramsB: 10, weightsGB: 30 }),
    ];
    const ranked = rankLocalModels(profile({ bandwidthGBps: 400, usableMemoryGB: 100 }), catalog);
    expect(ranked.map((fit) => [fit.model.id, fit.tier])).toEqual([
      ["mid", "comfortable"],
      ["fast-large", "comfortable"],
      ["fast-small", "comfortable"],
      ["fast-thinking", "comfortable"],
      ["slow-big", "slow"],
      ["slow-small", "slow"],
      ["never", "no-fit"],
    ]);
  });

  it("returns every catalog entry", () => {
    const catalog = [model({ id: "a" }), model({ id: "b", weightsGB: 900 })];
    expect(rankLocalModels(profile(), catalog)).toHaveLength(2);
  });
});

describe("matchHardware", () => {
  const table = [
    entry("m4", /\bM4\b/),
    entry("m4-max", /\bM4 Max\b/),
    entry("rtx-4060", /RTX 4060/),
    entry("rtx-4060-ti", /RTX 4060 Ti/),
  ];

  it("prefers the more specific entry whatever the table order", () => {
    const max = "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)";
    const plain = "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)";
    const ti = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)";
    const base = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
    for (const t of [table, [...table].reverse()]) {
      expect(matchHardware(max, t)?.id).toBe("m4-max");
      expect(matchHardware(plain, t)?.id).toBe("m4");
      expect(matchHardware(ti, t)?.id).toBe("rtx-4060-ti");
      expect(matchHardware(base, t)?.id).toBe("rtx-4060");
    }
  });

  it("returns null for null, empty and unknown renderers", () => {
    expect(matchHardware(null, table)).toBeNull();
    expect(matchHardware("", table)).toBeNull();
    expect(matchHardware("Apple GPU", table)).toBeNull();
    expect(matchHardware("Apple M4 Max", [])).toBeNull();
  });

  it("is not confused by a pattern with the global flag", () => {
    const global = [entry("g", /RTX 4090/g)];
    const renderer = "NVIDIA GeForce RTX 4090";
    expect(matchHardware(renderer, global)?.id).toBe("g");
    expect(matchHardware(renderer, global)?.id).toBe("g");
  });
});
