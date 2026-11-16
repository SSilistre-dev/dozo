import { describe, expect, it } from "vitest";
import {
  LOCAL_HARDWARE,
  LOCAL_MODEL_CANDIDATES,
  LOCAL_MODELS,
  LOCAL_RUNTIME,
} from "./dozo-local-model-catalog";
import {
  hardwareProfile,
  LOCAL_MODEL_CONTEXT_TOKENS,
  matchHardware,
  rankLocalModels,
} from "./dozo-local-model-fit";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function apple(chip: string): string {
  return `ANGLE (Apple, ANGLE Metal Renderer: Apple ${chip}, Unspecified Version)`;
}

function direct3d(vendor: string, card: string): string {
  return `ANGLE (${vendor}, ${card} Direct3D11 vs_5_0 ps_5_0, D3D11)`;
}

// A renderer string in the form Chromium reports it, for each table entry.
const SAMPLE: Record<string, string> = {
  "apple-m1": apple("M1"),
  "apple-m1-pro": apple("M1 Pro"),
  "apple-m1-max": apple("M1 Max"),
  "apple-m2": apple("M2"),
  "apple-m4": apple("M4"),
  "apple-m4-pro": apple("M4 Pro"),
  "apple-m4-max": apple("M4 Max"),
  "apple-m5": apple("M5"),
  "apple-m5-pro": apple("M5 Pro"),
  "apple-m5-max": apple("M5 Max"),
  "apple-m6": apple("M6"),
  "nvidia-rtx-5090": direct3d("NVIDIA", "NVIDIA GeForce RTX 5090"),
  "nvidia-rtx-5080": direct3d("NVIDIA", "NVIDIA GeForce RTX 5080"),
  "nvidia-rtx-5070-ti": direct3d("NVIDIA", "NVIDIA GeForce RTX 5070 Ti"),
  "nvidia-rtx-5070": direct3d("NVIDIA", "NVIDIA GeForce RTX 5070"),
  "nvidia-rtx-5060-ti": direct3d("NVIDIA", "NVIDIA GeForce RTX 5060 Ti"),
  "nvidia-rtx-4090": direct3d("NVIDIA", "NVIDIA GeForce RTX 4090"),
  "nvidia-rtx-4080": direct3d("NVIDIA", "NVIDIA GeForce RTX 4080"),
  "nvidia-rtx-4070": direct3d("NVIDIA", "NVIDIA GeForce RTX 4070"),
  "nvidia-rtx-4060-ti": direct3d("NVIDIA", "NVIDIA GeForce RTX 4060 Ti"),
  "nvidia-rtx-3090": direct3d("NVIDIA", "NVIDIA GeForce RTX 3090"),
  "nvidia-rtx-3080": direct3d("NVIDIA", "NVIDIA GeForce RTX 3080"),
  "amd-rx-7900-xtx": direct3d("AMD", "AMD Radeon RX 7900 XTX"),
  "amd-rx-9070-xt": direct3d("AMD", "AMD Radeon RX 9070 XT"),
  "intel-arc-b580": direct3d("Intel", "Intel(R) Arc(TM) B580 Graphics"),
};

describe("LOCAL_HARDWARE", () => {
  it("has unique ids and a sample string for every entry", () => {
    const ids = LOCAL_HARDWARE.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(SAMPLE).sort());
  });

  it.each(LOCAL_HARDWARE)("$id carries evidence and real numbers", (entry) => {
    expect(entry.source).toMatch(/^https:\/\//);
    expect(entry.bandwidthGBps).toBeGreaterThan(0);
    expect(entry.memoryGB.length).toBeGreaterThan(0);
    expect(entry.memoryGB.every((gb) => gb > 0)).toBe(true);
  });

  it.each(LOCAL_HARDWARE)("$id wins on its own renderer string and on no other", (entry) => {
    const sample = SAMPLE[entry.id] ?? "";
    expect(matchHardware(sample, LOCAL_HARDWARE)?.id).toBe(entry.id);
    for (const other of LOCAL_HARDWARE) {
      if (other.id === entry.id) continue;
      const winner = matchHardware(SAMPLE[other.id] ?? "", LOCAL_HARDWARE);
      expect(winner?.id).toBe(other.id);
    }
  });

  it("keeps specific chips and cards apart from their relatives", () => {
    expect(matchHardware(apple("M4 Pro"), LOCAL_HARDWARE)?.id).toBe("apple-m4-pro");
    expect(
      matchHardware(direct3d("NVIDIA", "NVIDIA GeForce RTX 4060 Ti"), LOCAL_HARDWARE)?.id,
    ).toBe("nvidia-rtx-4060-ti");
    expect(
      matchHardware(direct3d("NVIDIA", "NVIDIA GeForce RTX 5070 Ti"), LOCAL_HARDWARE)?.id,
    ).toBe("nvidia-rtx-5070-ti");
  });

  it("does not guess for hardware it has no figures for", () => {
    // Ultra chips overshoot the estimate, so they are left out on purpose.
    expect(matchHardware(apple("M1 Ultra"), LOCAL_HARDWARE)).toBeNull();
    expect(matchHardware(apple("M5 Ultra"), LOCAL_HARDWARE)).toBeNull();
    expect(matchHardware("Apple GPU", LOCAL_HARDWARE)).toBeNull();
    expect(matchHardware(null, LOCAL_HARDWARE)).toBeNull();
  });

  // A name that begins another product's name must not take that product's figures.
  const NO_ENTRY: [string, string][] = [
    // Notebook cards have less bandwidth and memory than the desktop card.
    ["4090 Laptop", direct3d("NVIDIA", "NVIDIA GeForce RTX 4090 Laptop GPU")],
    ["5070 Ti Laptop", direct3d("NVIDIA", "NVIDIA GeForce RTX 5070 Ti Laptop GPU")],
    ["5070 Laptop", direct3d("NVIDIA", "NVIDIA GeForce RTX 5070 Laptop GPU")],
    ["3080 Ti Laptop", direct3d("NVIDIA", "NVIDIA GeForce RTX 3080 Ti Laptop GPU")],
    ["4060 Ti Laptop", direct3d("NVIDIA", "NVIDIA GeForce RTX 4060 Ti Laptop GPU")],
    ["4080 Max-Q", direct3d("NVIDIA", "NVIDIA GeForce RTX 4080 Max-Q")],
    ["7900 XTX Mobile", direct3d("AMD", "AMD Radeon RX 7900 XTX Mobile")],
    ["Arc B580 Laptop", direct3d("Intel", "Intel(R) Arc(TM) B580 Laptop Graphics")],
    // Ti and SUPER cards without a row of their own.
    ["3080 Ti", direct3d("NVIDIA", "NVIDIA GeForce RTX 3080 Ti")],
    ["3090 Ti", direct3d("NVIDIA", "NVIDIA GeForce RTX 3090 Ti")],
    ["4070 SUPER", direct3d("NVIDIA", "NVIDIA GeForce RTX 4070 SUPER")],
    ["4070 Ti", direct3d("NVIDIA", "NVIDIA GeForce RTX 4070 Ti")],
    ["4070 Ti SUPER", direct3d("NVIDIA", "NVIDIA GeForce RTX 4070 Ti SUPER")],
    ["4080 SUPER", direct3d("NVIDIA", "NVIDIA GeForce RTX 4080 SUPER")],
    ["5080 SUPER", direct3d("NVIDIA", "NVIDIA GeForce RTX 5080 SUPER")],
    ["5060 Ti SUPER", direct3d("NVIDIA", "NVIDIA GeForce RTX 5060 Ti SUPER")],
    // Longer model numbers and cards of the same family without a row.
    ["5090D", direct3d("NVIDIA", "NVIDIA GeForce RTX 5090D")],
    ["50700", direct3d("NVIDIA", "NVIDIA GeForce RTX 50700")],
    ["5060", direct3d("NVIDIA", "NVIDIA GeForce RTX 5060")],
    ["RX 7900 XT", direct3d("AMD", "AMD Radeon RX 7900 XT")],
    ["RX 9070", direct3d("AMD", "AMD Radeon RX 9070")],
    ["Arc B5800", direct3d("Intel", "Intel(R) Arc(TM) B5800 Graphics")],
    ["Arc A580", direct3d("Intel", "Intel(R) Arc(TM) A580 Graphics")],
    // Apple chips whose Pro, Max or Ultra sibling has no row.
    ["M6 Pro", apple("M6 Pro")],
    ["M6 Max", apple("M6 Max")],
    ["M2 Pro", apple("M2 Pro")],
    ["M2 Max", apple("M2 Max")],
    ["M4 Ultra", apple("M4 Ultra")],
    ["M10", apple("M10")],
    ["M3", apple("M3")],
  ];

  it.each(NO_ENTRY)("matches nothing for %s", (_name, renderer) => {
    expect(matchHardware(renderer, LOCAL_HARDWARE)).toBeNull();
  });

  const OWN_ENTRY: [string, string, string][] = [
    ["RTX 5070 Ti", "NVIDIA GeForce RTX 5070 Ti", "nvidia-rtx-5070-ti"],
    ["RTX 5070", "NVIDIA GeForce RTX 5070", "nvidia-rtx-5070"],
    ["RTX 4060 Ti", "NVIDIA GeForce RTX 4060 Ti", "nvidia-rtx-4060-ti"],
    ["RTX 3080", "NVIDIA GeForce RTX 3080", "nvidia-rtx-3080"],
  ];

  it.each(OWN_ENTRY)("still matches the desktop %s", (_name, card, id) => {
    expect(matchHardware(direct3d("NVIDIA", card), LOCAL_HARDWARE)?.id).toBe(id);
  });
});

describe("LOCAL_RUNTIME", () => {
  it("pulls the tag and builds a derived model that carries the context", () => {
    const { command, modelId } = LOCAL_RUNTIME.prepare("qwen3.5:4b", 32768);
    expect(modelId).toBe("qwen3.5-4b-32k");
    expect(command).toContain("ollama pull qwen3.5:4b");
    expect(command).toContain("FROM qwen3.5:4b");
    expect(command).toContain("PARAMETER num_ctx 32768");
    expect(command).toContain(`ollama create ${modelId} -f `);
  });

  it("does not depend on how the server was started", () => {
    const { command } = LOCAL_RUNTIME.prepare("x:1b", 32768);
    expect(command).not.toContain("serve");
    expect(command).not.toContain("OLLAMA_CONTEXT_LENGTH");
  });

  it("names a derived model per context", () => {
    expect(LOCAL_RUNTIME.prepare("y:2b", 8192).modelId).toBe("y-2b-8k");
    expect(LOCAL_RUNTIME.prepare("y:2b", 8000).modelId).toBe("y-2b-8000");
    expect(LOCAL_RUNTIME.prepare("y:2b", 8192).command).toContain("num_ctx 8192");
  });

  it("points at a local OpenAI-compatible endpoint", () => {
    expect(LOCAL_RUNTIME.baseUrl).toMatch(/^http:\/\/localhost:\d+\/v1\/?$/);
  });
});

describe("LOCAL_MODEL_CANDIDATES", () => {
  it("is not empty and has unique ids and tags", () => {
    expect(LOCAL_MODEL_CANDIDATES.length).toBeGreaterThan(0);
    const ids = LOCAL_MODEL_CANDIDATES.map((model) => model.id);
    const tags = LOCAL_MODEL_CANDIDATES.map((model) => model.tag);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it.each(LOCAL_MODEL_CANDIDATES)("$id carries its evidence", (model) => {
    expect(["Apache-2.0", "MIT"]).toContain(model.licence);
    expect(model.source).toMatch(/^https:\/\//);
    expect(model.verifiedOn).toMatch(ISO_DATE);
    expect(Number.isNaN(Date.parse(model.verifiedOn))).toBe(false);
    expect(model.tag).toMatch(/^[a-z0-9.-]+:[a-z0-9.-]+$/);
  });

  it.each(LOCAL_MODEL_CANDIDATES)("$id has consistent sizes", (model) => {
    expect(model.paramsB).toBeGreaterThan(0);
    expect(model.weightsGB).toBeGreaterThan(0);
    expect(model.kvGBPer8k).toBeGreaterThan(0);
    if (model.activeParamsB !== undefined) {
      expect(model.activeParamsB).toBeGreaterThan(0);
      expect(model.activeParamsB).toBeLessThan(model.paramsB);
    }
  });

  it("covers small, medium and large sizes", () => {
    const sizes = LOCAL_MODEL_CANDIDATES.map((model) => model.paramsB);
    expect(sizes.some((b) => b >= 3 && b <= 5)).toBe(true);
    expect(sizes.some((b) => b >= 8 && b <= 14)).toBe(true);
    expect(sizes.some((b) => b >= 20 && b <= 35)).toBe(true);
  });

  it("derives a distinct, plainly spelled model name for every candidate", () => {
    const names = LOCAL_MODEL_CANDIDATES.map(
      (model) => LOCAL_RUNTIME.prepare(model.tag, LOCAL_MODEL_CONTEXT_TOKENS).modelId,
    );
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9][a-z0-9.-]*-32k$/);
  });
});

describe("LOCAL_MODELS", () => {
  it("holds only candidates a person has checked, each with a real date", () => {
    for (const model of LOCAL_MODELS) {
      expect(LOCAL_MODEL_CANDIDATES).toContain(model);
      expect(model.toolCallCheckedOn).toMatch(ISO_DATE);
      expect(Number.isNaN(Date.parse(model.toolCallCheckedOn))).toBe(false);
    }
  });

  it("leaves out every candidate whose check is empty", () => {
    const unchecked = LOCAL_MODEL_CANDIDATES.filter((model) => model.toolCallCheckedOn === "");
    for (const model of unchecked) expect(LOCAL_MODELS).not.toContain(model);
    expect(LOCAL_MODELS.length + unchecked.length).toBe(LOCAL_MODEL_CANDIDATES.length);
  });
});

describe("catalog with the estimator", () => {
  it("ranks the candidates for a chosen machine", () => {
    const entry = LOCAL_HARDWARE.find((hw) => hw.id === "apple-m4-max");
    expect(entry).toBeDefined();
    if (!entry) return;
    const ranked = rankLocalModels(hardwareProfile(entry, 64, "chosen"), LOCAL_MODEL_CANDIDATES);
    expect(ranked).toHaveLength(LOCAL_MODEL_CANDIDATES.length);
    // 64 GB of unified memory holds every candidate at a 32k context.
    expect(ranked.every((fit) => fit.tier !== "no-fit")).toBe(true);
    expect(ranked[0]?.tier).toBe("comfortable");
  });
});
