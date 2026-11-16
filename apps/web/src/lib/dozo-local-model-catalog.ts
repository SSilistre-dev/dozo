// Curated data for the local model estimator. Every number was read from the
// page named in `source` (or in the comment above the entry) on `verifiedOn`.
// Leave out what could not be confirmed instead of guessing.

import type { HardwareEntry, LocalModelEntry, LocalRuntime } from "./dozo-local-model-fit";

const APPLE_M1 = "https://en.wikipedia.org/wiki/Apple_M1";
const APPLE_M2 = "https://en.wikipedia.org/wiki/Apple_M2";
const APPLE_M4 = "https://en.wikipedia.org/wiki/Apple_M4";
const APPLE_AIR_SPECS = "https://www.apple.com/macbook-air/specs/";
const APPLE_PRO_SPECS = "https://www.apple.com/macbook-pro/specs/";
const NVIDIA_50 = "https://en.wikipedia.org/wiki/GeForce_RTX_50_series";
const NVIDIA_40 = "https://en.wikipedia.org/wiki/GeForce_40_series";
const NVIDIA_30 = "https://en.wikipedia.org/wiki/GeForce_30_series";
const AMD_7900_XTX =
  "https://www.amd.com/en/products/graphics/desktops/radeon/7000-series/amd-radeon-rx-7900xtx.html";
const AMD_9070_XT =
  "https://www.amd.com/en/products/graphics/desktops/radeon/9000-series/amd-radeon-rx-9070xt.html";
const INTEL_ARC = "https://en.wikipedia.org/wiki/Intel_Arc";

// Bandwidth is the lower figure when a chip ships in two variants, so a
// speed is never promised that a smaller variant cannot reach. Notebook
// graphics cards are excluded by pattern: they have less bandwidth and memory
// than the desktop card of the same name.
//
// Ultra chips are left out on purpose. In the llama.cpp measurements they
// reach only about 0.35 to 0.45 of bandwidth over file size, so the estimate
// would overstate their speed by more than the tolerance allows.
const NOT_MOBILE = "(?! (?:Laptop|Max-Q))";

export const LOCAL_HARDWARE: readonly HardwareEntry[] = [
  {
    id: "apple-m1",
    label: "Apple M1",
    kind: "unified",
    match: /\bM1\b(?! Ultra)/,
    bandwidthGBps: 68,
    memoryGB: [8, 16],
    source: APPLE_M1,
  },
  {
    id: "apple-m1-pro",
    label: "Apple M1 Pro",
    kind: "unified",
    match: /\bM1 Pro\b/,
    bandwidthGBps: 200,
    memoryGB: [16, 32],
    source: APPLE_M1,
  },
  {
    id: "apple-m1-max",
    label: "Apple M1 Max",
    kind: "unified",
    match: /\bM1 Max\b/,
    bandwidthGBps: 400,
    memoryGB: [32, 64],
    source: APPLE_M1,
  },
  {
    id: "apple-m2",
    label: "Apple M2",
    kind: "unified",
    match: /\bM2\b(?! (?:Pro|Max|Ultra))/,
    bandwidthGBps: 100,
    memoryGB: [8, 16, 24],
    source: APPLE_M2,
  },
  {
    // The 8 and 12 GB sizes of this chip are iPad-only per the source.
    id: "apple-m4",
    label: "Apple M4",
    kind: "unified",
    match: /\bM4\b(?! Ultra)/,
    bandwidthGBps: 120,
    memoryGB: [16, 24, 32],
    source: APPLE_M4,
  },
  {
    id: "apple-m4-pro",
    label: "Apple M4 Pro",
    kind: "unified",
    match: /\bM4 Pro\b/,
    bandwidthGBps: 273,
    memoryGB: [24, 48, 64],
    source: APPLE_M4,
  },
  {
    // 410 GB/s is the 32-core GPU variant; the 40-core one has 546 GB/s.
    id: "apple-m4-max",
    label: "Apple M4 Max",
    kind: "unified",
    match: /\bM4 Max\b/,
    bandwidthGBps: 410,
    memoryGB: [36, 48, 64, 128],
    source: APPLE_M4,
  },
  {
    id: "apple-m5",
    label: "Apple M5",
    kind: "unified",
    match: /\bM5\b(?! Ultra)/,
    bandwidthGBps: 153,
    memoryGB: [16, 24, 32],
    source: APPLE_AIR_SPECS,
  },
  {
    id: "apple-m5-pro",
    label: "Apple M5 Pro",
    kind: "unified",
    match: /\bM5 Pro\b/,
    bandwidthGBps: 307,
    memoryGB: [24, 48, 64],
    source: APPLE_PRO_SPECS,
  },
  {
    // 460 GB/s is the 32-core GPU variant; the 40-core one has 614 GB/s.
    id: "apple-m5-max",
    label: "Apple M5 Max",
    kind: "unified",
    match: /\bM5 Max\b/,
    bandwidthGBps: 460,
    memoryGB: [36, 48, 64, 128],
    source: APPLE_PRO_SPECS,
  },
  {
    // The page lists 153 GB/s with 16 GB and 170 GB/s with 24 or 32 GB.
    id: "apple-m6",
    label: "Apple M6",
    kind: "unified",
    match: /\bM6\b(?! Ultra)/,
    bandwidthGBps: 153,
    memoryGB: [16, 24, 32],
    source: APPLE_PRO_SPECS,
  },
  {
    id: "nvidia-rtx-5090",
    label: "NVIDIA GeForce RTX 5090",
    kind: "gpu",
    match: new RegExp(`RTX 5090${NOT_MOBILE}`),
    bandwidthGBps: 1792,
    memoryGB: [32],
    source: NVIDIA_50,
  },
  {
    id: "nvidia-rtx-5080",
    label: "NVIDIA GeForce RTX 5080",
    kind: "gpu",
    match: new RegExp(`RTX 5080${NOT_MOBILE}`),
    bandwidthGBps: 960,
    memoryGB: [16],
    source: NVIDIA_50,
  },
  {
    id: "nvidia-rtx-5070-ti",
    label: "NVIDIA GeForce RTX 5070 Ti",
    kind: "gpu",
    match: new RegExp(`RTX 5070 Ti${NOT_MOBILE}`),
    bandwidthGBps: 896,
    memoryGB: [16],
    source: NVIDIA_50,
  },
  {
    id: "nvidia-rtx-5070",
    label: "NVIDIA GeForce RTX 5070",
    kind: "gpu",
    match: new RegExp(`RTX 5070${NOT_MOBILE}`),
    bandwidthGBps: 672,
    memoryGB: [12],
    source: NVIDIA_50,
  },
  {
    id: "nvidia-rtx-5060-ti",
    label: "NVIDIA GeForce RTX 5060 Ti",
    kind: "gpu",
    match: new RegExp(`RTX 5060 Ti${NOT_MOBILE}`),
    bandwidthGBps: 448,
    memoryGB: [8, 16],
    source: NVIDIA_50,
  },
  {
    id: "nvidia-rtx-4090",
    label: "NVIDIA GeForce RTX 4090",
    kind: "gpu",
    match: new RegExp(`RTX 4090${NOT_MOBILE}`),
    bandwidthGBps: 1008,
    memoryGB: [24],
    source: NVIDIA_40,
  },
  {
    id: "nvidia-rtx-4080",
    label: "NVIDIA GeForce RTX 4080",
    kind: "gpu",
    match: new RegExp(`RTX 4080${NOT_MOBILE}`),
    bandwidthGBps: 716.8,
    memoryGB: [16],
    source: NVIDIA_40,
  },
  {
    id: "nvidia-rtx-4070",
    label: "NVIDIA GeForce RTX 4070",
    kind: "gpu",
    match: new RegExp(`RTX 4070${NOT_MOBILE}`),
    bandwidthGBps: 504,
    memoryGB: [12],
    source: NVIDIA_40,
  },
  {
    id: "nvidia-rtx-4060-ti",
    label: "NVIDIA GeForce RTX 4060 Ti",
    kind: "gpu",
    match: new RegExp(`RTX 4060 Ti${NOT_MOBILE}`),
    bandwidthGBps: 288,
    memoryGB: [8, 16],
    source: NVIDIA_40,
  },
  {
    id: "nvidia-rtx-3090",
    label: "NVIDIA GeForce RTX 3090",
    kind: "gpu",
    match: new RegExp(`RTX 3090${NOT_MOBILE}`),
    bandwidthGBps: 936,
    memoryGB: [24],
    source: NVIDIA_30,
  },
  {
    // The 12 GB variant has 912 GB/s; this is the 10 GB one.
    id: "nvidia-rtx-3080",
    label: "NVIDIA GeForce RTX 3080",
    kind: "gpu",
    match: new RegExp(`RTX 3080${NOT_MOBILE}`),
    bandwidthGBps: 760,
    memoryGB: [10, 12],
    source: NVIDIA_30,
  },
  {
    id: "amd-rx-7900-xtx",
    label: "AMD Radeon RX 7900 XTX",
    kind: "gpu",
    match: /RX 7900 XTX/,
    bandwidthGBps: 960,
    memoryGB: [24],
    source: AMD_7900_XTX,
  },
  {
    id: "amd-rx-9070-xt",
    label: "AMD Radeon RX 9070 XT",
    kind: "gpu",
    match: /RX 9070 XT/,
    bandwidthGBps: 640,
    memoryGB: [16],
    source: AMD_9070_XT,
  },
  {
    id: "intel-arc-b580",
    label: "Intel Arc B580",
    kind: "gpu",
    match: /Arc(?:\(TM\))? B580/,
    bandwidthGBps: 456,
    memoryGB: [12],
    source: INTEL_ARC,
  },
];

// Sources (read 2026-11-16):
// https://docs.ollama.com/api/openai-compatibility, "Setting the local context
//   size": the OpenAI API cannot set the context, so create a Modelfile with
//   `FROM <model>` and `PARAMETER num_ctx <n>`, build it with `ollama create`,
//   and call the API with the new model name.
// https://docs.ollama.com/modelfile: `ollama create <name> -f <path to file>`.
// The docs do not say `-f` reads standard input, so the line writes a file.
// A derived model keeps its context whether or not the runtime's app is already
// serving, unlike `OLLAMA_CONTEXT_LENGTH`, which only a server started with it
// reads (https://docs.ollama.com/context-length). Not run: no runtime was
// available. The line is for macOS and Linux shells; PowerShell needs another.
export const LOCAL_RUNTIME: LocalRuntime = {
  label: "Ollama",
  baseUrl: "http://localhost:11434/v1/",
  prepare: (tag, contextTokens) => {
    const size = contextTokens % 1024 === 0 ? `${contextTokens / 1024}k` : String(contextTokens);
    const modelId = `${tag.replace(/:/g, "-")}-${size}`;
    const file = `printf 'FROM ${tag}\nPARAMETER num_ctx ${contextTokens}\n' > "$f"`;
    return {
      command: `ollama pull ${tag} && f=$(mktemp) && ${file} && ollama create ${modelId} -f "$f"; rm -f "$f"`,
      modelId,
    };
  },
};

// One group of attention layers that keep a key and value per token. Layers
// with a sliding window keep at most the window; those are counted at the
// window, which is the most the cache can hold, and the estimator scales the
// total with the context, so a longer context is over- rather than
// under-estimated for them.
type AttentionLayers = {
  count: number;
  kvHeads: number;
  headDim: number;
  window?: number;
};

// 2 for key and value, 2 bytes per value (16-bit cache), tokens per 8k block.
// Layers that keep a fixed-size recurrent state instead of a cache (the
// linear-attention layers of the Qwen entries) are not counted; their state
// does not grow with the context and is small next to the runtime allowance.
function kvGBPer8k(groups: readonly AttentionLayers[]): number {
  const bytes = groups.reduce(
    (sum, group) =>
      sum +
      2 * group.count * group.kvHeads * group.headDim * Math.min(8192, group.window ?? 8192) * 2,
    0,
  );
  return bytes / 1e9;
}

const VERIFIED_ON = "2026-11-16";

// Sizes are the larger of the two builds listed on the runtime's tag page
// (the llama.cpp and the MLX build), so memory is never under-counted.
// Licences are the `License: apache-2.0` line of each Hugging Face card and
// the licence text on the Ollama tag page. Architecture numbers come from the
// card or the repository's config.json. Tool calling is documented on every
// card (a chat template and parser for the Qwen cards, a Function Calling
// capability for the Gemma cards, native function calling for gpt-oss).
export const LOCAL_MODEL_CANDIDATES: readonly LocalModelEntry[] = [
  {
    // https://ollama.com/library/qwen3.5:4b (4.0 GB MLX, 3.3 GB llama.cpp)
    // Card: 8 x (3 x linear attention, 1 x full attention) layers, full
    // attention has 4 KV heads of dimension 256; thinking by default.
    id: "qwen3.5-4b",
    label: "Qwen3.5 4B",
    tag: "qwen3.5:4b",
    licence: "Apache-2.0",
    paramsB: 4,
    weightsGB: 4.0,
    kvGBPer8k: kvGBPer8k([{ count: 8, kvHeads: 4, headDim: 256 }]),
    thinking: true,
    source: "https://huggingface.co/Qwen/Qwen3.5-4B",
    verifiedOn: VERIFIED_ON,
    toolCallCheckedOn: "",
  },
  {
    // https://ollama.com/library/qwen3.5:9b (7.6 GB MLX, 6.6 GB llama.cpp)
    // Same attention layout as the 4B card.
    id: "qwen3.5-9b",
    label: "Qwen3.5 9B",
    tag: "qwen3.5:9b",
    licence: "Apache-2.0",
    paramsB: 9,
    weightsGB: 7.6,
    kvGBPer8k: kvGBPer8k([{ count: 8, kvHeads: 4, headDim: 256 }]),
    thinking: true,
    source: "https://huggingface.co/Qwen/Qwen3.5-9B",
    verifiedOn: VERIFIED_ON,
    toolCallCheckedOn: "",
  },
  {
    // https://ollama.com/library/gemma4:12b (7.7 GB MLX, 8.0 GB llama.cpp)
    // config.json: 40 sliding layers (window 1024, 8 KV heads of 256) and
    // 8 full layers (1 KV head of 512). Thinking is off unless requested.
    id: "gemma4-12b",
    label: "Gemma 4 12B",
    tag: "gemma4:12b",
    licence: "Apache-2.0",
    paramsB: 11.9,
    weightsGB: 8.0,
    kvGBPer8k: kvGBPer8k([
      { count: 40, kvHeads: 8, headDim: 256, window: 1024 },
      { count: 8, kvHeads: 1, headDim: 512 },
    ]),
    thinking: false,
    source: "https://huggingface.co/google/gemma-4-12b-it",
    verifiedOn: VERIFIED_ON,
    toolCallCheckedOn: "",
  },
  {
    // https://ollama.com/library/gpt-oss:20b (14 GB)
    // Card: 21B parameters, 3.6B active. config.json: 12 sliding layers
    // (window 128) and 12 full layers, 8 KV heads of 64. Always reasons.
    id: "gpt-oss-20b",
    label: "gpt-oss 20B",
    tag: "gpt-oss:20b",
    licence: "Apache-2.0",
    paramsB: 21,
    activeParamsB: 3.6,
    weightsGB: 14,
    kvGBPer8k: kvGBPer8k([
      { count: 12, kvHeads: 8, headDim: 64, window: 128 },
      { count: 12, kvHeads: 8, headDim: 64 },
    ]),
    thinking: true,
    source: "https://huggingface.co/openai/gpt-oss-20b",
    verifiedOn: VERIFIED_ON,
    toolCallCheckedOn: "",
  },
  {
    // https://ollama.com/library/gemma4:26b (16 GB MLX, 19 GB llama.cpp)
    // Card: 25.2B parameters, 3.8B active. config.json: 25 sliding layers
    // (window 1024, 8 KV heads of 256) and 5 full layers (2 KV heads of
    // 512). Thinking is off unless requested.
    id: "gemma4-26b-a4b",
    label: "Gemma 4 26B A4B",
    tag: "gemma4:26b",
    licence: "Apache-2.0",
    paramsB: 25.2,
    activeParamsB: 3.8,
    weightsGB: 19,
    kvGBPer8k: kvGBPer8k([
      { count: 25, kvHeads: 8, headDim: 256, window: 1024 },
      { count: 5, kvHeads: 2, headDim: 512 },
    ]),
    thinking: false,
    source: "https://huggingface.co/google/gemma-4-26b-a4b-it",
    verifiedOn: VERIFIED_ON,
    toolCallCheckedOn: "",
  },
  {
    // https://ollama.com/library/qwen3.6:27b (19 GB MLX, 18 GB llama.cpp)
    // Card: 16 x (3 x linear attention, 1 x full attention) layers, full
    // attention has 4 KV heads of dimension 256; thinking by default.
    id: "qwen3.6-27b",
    label: "Qwen3.6 27B",
    tag: "qwen3.6:27b",
    licence: "Apache-2.0",
    paramsB: 27,
    weightsGB: 19,
    kvGBPer8k: kvGBPer8k([{ count: 16, kvHeads: 4, headDim: 256 }]),
    thinking: true,
    source: "https://huggingface.co/Qwen/Qwen3.6-27B",
    verifiedOn: VERIFIED_ON,
    toolCallCheckedOn: "",
  },
  {
    // https://ollama.com/library/qwen3.6:35b (23 GB both builds)
    // Card: 35B parameters, 3B active; 10 x (3 x linear attention, 1 x
    // full attention) layers, full attention has 2 KV heads of 256.
    id: "qwen3.6-35b-a3b",
    label: "Qwen3.6 35B A3B",
    tag: "qwen3.6:35b",
    licence: "Apache-2.0",
    paramsB: 35,
    activeParamsB: 3,
    weightsGB: 23,
    kvGBPer8k: kvGBPer8k([{ count: 10, kvHeads: 2, headDim: 256 }]),
    thinking: true,
    source: "https://huggingface.co/Qwen/Qwen3.6-35B-A3B",
    verifiedOn: VERIFIED_ON,
    toolCallCheckedOn: "",
  },
];

// Only models whose tool calling a person has run against the runtime.
export const LOCAL_MODELS: readonly LocalModelEntry[] = LOCAL_MODEL_CANDIDATES.filter(
  (model) => model.toolCallCheckedOn !== "",
);
