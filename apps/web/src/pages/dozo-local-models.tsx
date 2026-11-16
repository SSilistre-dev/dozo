import { useLingui } from "@lingui/react/macro";
import type { SettingsScope } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import {
  Disclosure,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rakazo/ui-web";
import { useMemo, useState } from "react";
import { LOCAL_HARDWARE, LOCAL_MODELS, LOCAL_RUNTIME } from "../lib/dozo-local-model-catalog";
import type { HardwareEntry, LocalModelEntry } from "../lib/dozo-local-model-fit";
import {
  hardwareProfile,
  LOCAL_MODEL_CONTEXT_TOKENS,
  matchHardware,
  rankLocalModels,
} from "../lib/dozo-local-model-fit";
import { useSave, useSpaceQueries } from "../lib/query";
import { connectionKey, LocalModelRows } from "./dozo-local-model-rows";

const MAX_ROWS = 3;

/** The graphics renderer string the browser reports, or null when it will not say. */
export function readGpuRenderer(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    try {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      if (!info) return null;
      const renderer: unknown = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
      return typeof renderer === "string" && renderer ? renderer : null;
    } finally {
      // Every path lets go of the context; a page keeps only a few.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    return null;
  }
}

const lowest = (values: readonly number[]) => Math.min(...values);

/** The chosen memory when this hardware offers it, else its smallest option. */
function pickMemory(entry: HardwareEntry | null, choice: number | null): number | null {
  if (!entry) return null;
  if (choice !== null && entry.memoryGB.includes(choice)) return choice;
  return lowest(entry.memoryGB);
}

function HardwarePickers({
  hardware,
  hardwareId,
  entry,
  memoryGB,
  onHardware,
  onMemory,
}: {
  hardware: readonly HardwareEntry[];
  hardwareId: string | null;
  entry: HardwareEntry | null;
  memoryGB: number | null;
  onHardware: (id: string) => void;
  onMemory: (gb: number) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        value={hardwareId}
        onValueChange={(value) => {
          if (typeof value !== "string" || !value) return;
          onHardware(value);
        }}
        items={hardware.map((item) => ({ value: item.id, label: item.label }))}
      >
        <SelectTrigger aria-label={t`Hardware`} className="rounded-full">
          <SelectValue placeholder={t`Hardware`} />
        </SelectTrigger>
        <SelectContent>
          {hardware.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {entry && memoryGB !== null ? (
        <Select
          value={String(memoryGB)}
          onValueChange={(value) => {
            if (typeof value !== "string" || !value) return;
            onMemory(Number(value));
          }}
          items={entry.memoryGB.map((gb) => ({ value: String(gb), label: t`${gb} GB` }))}
        >
          <SelectTrigger aria-label={t`Memory`} className="rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {entry.memoryGB.map((gb) => (
              <SelectItem key={gb} value={String(gb)}>
                {t`${gb} GB`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}

function LocalModelsBody({
  onConnected,
  scope,
  makeDefault,
  renderer,
  hardware,
  models,
}: {
  onConnected?: () => void;
  scope?: SettingsScope;
  makeDefault?: boolean;
  renderer?: string | null;
  hardware: readonly HardwareEntry[];
  models: readonly LocalModelEntry[];
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [matched] = useState(() =>
    matchHardware(renderer === undefined ? readGpuRenderer() : renderer, hardware),
  );
  const [hardwareId, setHardwareId] = useState<string | null>(matched?.id ?? null);
  const [memoryChoice, setMemoryChoice] = useState<number | null>(null);
  const [baseUrl, setBaseUrl] = useState(LOCAL_RUNTIME.baseUrl);
  // Server and model pairs connected from this panel, so a second click cannot add the same
  // connection again while the same model on another address stays connectable.
  const [connectedKeys, setConnectedKeys] = useState<readonly string[]>([]);

  const save = useSave({
    save: (input: { modelId: string; baseUrl: string }, rpc) =>
      rpc.models.connect({
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        baseUrl: input.baseUrl,
        modelId: input.modelId,
        contextWindow: LOCAL_MODEL_CONTEXT_TOKENS,
        // A new connection, so a hosted one already saved is never overwritten.
        credentialId: null,
        // Omitted, the server picks the scope and makes the model the main one.
        ...(scope === undefined ? {} : { scope }),
        ...(makeDefault === undefined ? {} : { makeDefault }),
      }),
    stale: [
      queries.models.list.queryKey(),
      queries.models.credentials.queryKey(),
      queries.me.queryKey(),
    ],
    onSaved: (_saved, input) => {
      setConnectedKeys((keys) => [...keys, connectionKey(input.baseUrl, input.modelId)]);
      onConnected?.();
    },
  });

  const entry = hardware.find((item) => item.id === hardwareId) ?? null;
  const memoryGB = pickMemory(entry, memoryChoice);
  const rows = useMemo(() => {
    if (!entry || memoryGB === null) return [];
    const profile = hardwareProfile(entry, memoryGB, entry === matched ? "detected" : "chosen");
    return rankLocalModels(profile, models)
      .filter((fit) => fit.tier === "comfortable" || fit.tier === "usable")
      .slice(0, MAX_ROWS);
  }, [entry, memoryGB, matched, models]);

  let suggestions = null;
  if (rows.length > 0) {
    suggestions = (
      <>
        <LocalModelRows
          rows={rows}
          baseUrl={baseUrl}
          connectedKeys={connectedKeys}
          pending={save.pending}
          error={save.error}
          errorModelId={save.input?.modelId}
          onConnect={(modelId) => save.run({ modelId, baseUrl: baseUrl.trim() })}
        />
        <Input
          aria-label={t`Address`}
          className="rounded-full"
          value={baseUrl}
          onChange={(event) => {
            setBaseUrl(event.target.value);
            save.reset();
          }}
        />
      </>
    );
  } else if (entry && memoryGB !== null) {
    suggestions = <p className="text-body text-muted-foreground">{t`Nothing fits`}</p>;
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      <HardwarePickers
        hardware={hardware}
        hardwareId={hardwareId}
        entry={entry}
        memoryGB={memoryGB}
        onHardware={(id) => {
          setHardwareId(id);
          setMemoryChoice(null);
          save.reset();
        }}
        onMemory={(gb) => {
          setMemoryChoice(gb);
          save.reset();
        }}
      />
      {suggestions}
    </div>
  );
}

/** Local open-weight models that fit this computer, connected in one click. */
export function DozoLocalModels({
  onConnected,
  scope,
  makeDefault,
  renderer,
  hardware = LOCAL_HARDWARE,
  models = LOCAL_MODELS,
}: {
  onConnected?: () => void;
  /** Where a connected model becomes the main one; omitted, the server decides. */
  scope?: SettingsScope;
  /** False keeps the current main model; omitted, the connected model becomes it. */
  makeDefault?: boolean;
  /** `renderer`, `hardware` and `models` are the seam for tests and screenshots; the app passes none. */
  renderer?: string | null;
  hardware?: readonly HardwareEntry[];
  models?: readonly LocalModelEntry[];
}) {
  const { t } = useLingui();
  // Nothing detects or reads until the first open; after that it keeps its state while folded.
  const [opened, setOpened] = useState(false);
  // Until a person has recorded a tool-calling check there is nothing to offer, so nothing shows.
  if (models.length === 0) return null;
  return (
    <Disclosure
      className="text-body text-foreground"
      summary={t`Run on this computer`}
      onOpenChange={(open) => {
        if (open) setOpened(true);
      }}
    >
      {opened ? (
        <LocalModelsBody
          onConnected={onConnected}
          scope={scope}
          makeDefault={makeDefault}
          renderer={renderer}
          hardware={hardware}
          models={models}
        />
      ) : null}
    </Disclosure>
  );
}
