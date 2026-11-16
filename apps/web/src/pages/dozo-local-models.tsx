import { useLingui } from "@lingui/react/macro";
import type { SettingsScope } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import {
  Button,
  Disclosure,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useCopyText,
} from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { LOCAL_HARDWARE, LOCAL_MODELS, LOCAL_RUNTIME } from "../lib/dozo-local-model-catalog";
import type { HardwareEntry, LocalModelEntry } from "../lib/dozo-local-model-fit";
import {
  hardwareProfile,
  LOCAL_MODEL_CONTEXT_TOKENS,
  matchHardware,
  rankLocalModels,
} from "../lib/dozo-local-model-fit";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";

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
const oneDecimal = (value: number) => Number(value.toFixed(1));

function CopyCommand({ text, label }: { text: string; label: string }) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <Button
      variant="outline"
      size="sm"
      className="rounded-full"
      aria-label={`${t`Copy`} ${label}`}
      onClick={() => void copy(text)}
    >
      {copied ? <Check /> : <Copy />}
      {t`Copy`}
    </Button>
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
  const [detected] = useState(() => (renderer === undefined ? readGpuRenderer() : renderer));
  const [matched] = useState(() => matchHardware(detected, hardware));
  const [hardwareId, setHardwareId] = useState<string | null>(matched?.id ?? null);
  const [memoryChoice, setMemoryChoice] = useState<number | null>(null);
  const [baseUrl, setBaseUrl] = useState(LOCAL_RUNTIME.baseUrl);
  // Models connected from this panel, so a second click cannot add the same connection again.
  const [connectedIds, setConnectedIds] = useState<readonly string[]>([]);

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
      setConnectedIds((ids) => [...ids, input.modelId]);
      onConnected?.();
    },
  });

  const entry = hardware.find((item) => item.id === hardwareId) ?? null;
  const memoryGB =
    entry && memoryChoice !== null && entry.memoryGB.includes(memoryChoice)
      ? memoryChoice
      : entry
        ? lowest(entry.memoryGB)
        : null;
  const rows =
    entry && memoryGB !== null
      ? rankLocalModels(
          hardwareProfile(entry, memoryGB, entry === matched ? "detected" : "chosen"),
          models,
        )
          .filter((fit) => fit.tier === "comfortable" || fit.tier === "usable")
          .slice(0, MAX_ROWS)
      : [];

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Select
          value={hardwareId}
          onValueChange={(value) => {
            if (typeof value !== "string" || !value) return;
            setHardwareId(value);
            setMemoryChoice(null);
            save.reset();
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
              setMemoryChoice(Number(value));
              save.reset();
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
      {entry && memoryGB !== null && rows.length === 0 ? (
        <p className="text-body text-muted-foreground">{t`Nothing fits`}</p>
      ) : rows.length > 0 ? (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map(({ model, tokensPerSecond }) => {
              const { command, modelId } = LOCAL_RUNTIME.prepare(
                model.tag,
                LOCAL_MODEL_CONTEXT_TOKENS,
              );
              const connected = connectedIds.includes(modelId);
              return (
                <li key={model.id} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body text-foreground">{model.label}</span>
                    <span className="text-body text-muted-foreground">
                      {t`${Math.round(tokensPerSecond)} tok/s`}
                    </span>
                    <span className="text-body text-muted-foreground">
                      {t`${oneDecimal(model.weightsGB)} GB`}
                    </span>
                    <span className="ml-auto flex gap-2">
                      <CopyCommand text={command} label={model.label} />
                      <Button
                        size="sm"
                        className="rounded-full"
                        aria-label={`${connected ? t`Connected` : t`Connect`} ${model.label}`}
                        disabled={connected || save.pending || !baseUrl.trim()}
                        onClick={() => save.run({ modelId, baseUrl: baseUrl.trim() })}
                      >
                        {connected ? t`Connected` : t`Connect`}
                      </Button>
                    </span>
                  </div>
                  {save.error && save.input?.modelId === modelId ? (
                    <p className="text-body text-destructive" role="alert">
                      {errorText(save.error, t`Could not connect this provider`)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
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
      ) : null}
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
