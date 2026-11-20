import { useLingui } from "@lingui/react/macro";
import type { DozoLocalModelServer, SettingsScope } from "@rakazo/contracts";
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
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
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
import { errorText } from "../lib/user-error";
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

/** The model servers running on this computer, each model connected in one click. */
function LocalServers({
  servers,
  onConnected,
  scope,
  makeDefault,
}: {
  servers: readonly DozoLocalModelServer[];
  onConnected?: () => void;
  scope?: SettingsScope;
  makeDefault?: boolean;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [connectedKeys, setConnectedKeys] = useState<readonly string[]>([]);
  const save = useSave({
    save: (input: { server: DozoLocalModelServer; modelId: string }, rpc) =>
      rpc.models.connect({
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        baseUrl: input.server.baseUrl,
        modelId: input.modelId,
        label: input.server.name,
        // A new connection, so one already saved is never overwritten.
        credentialId: null,
        ...(scope === undefined ? {} : { scope }),
        ...(makeDefault === undefined ? {} : { makeDefault }),
      }),
    stale: [
      queries.models.list.queryKey(),
      queries.models.credentials.queryKey(),
      queries.me.queryKey(),
    ],
    onSaved: (_saved, input) => {
      setConnectedKeys((keys) => [...keys, connectionKey(input.server.baseUrl, input.modelId)]);
      onConnected?.();
    },
  });

  if (servers.length === 0) {
    return <p className="mt-3 text-body text-muted-foreground">{t`No model server is running`}</p>;
  }
  return (
    <div className="mt-3 flex flex-col gap-3">
      {servers.map((server) => (
        <section key={server.baseUrl} aria-label={server.name} className="flex flex-col gap-2">
          <p className="text-body text-muted-foreground">{server.name}</p>
          {server.models.length === 0 ? (
            <p className="text-body text-muted-foreground">{t`No models listed.`}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {server.models.map((modelId) => {
                // Named as the estimator's rows name it, so both share their translated copy.
                const label = modelId;
                const connected = connectedKeys.includes(connectionKey(server.baseUrl, modelId));
                const failed =
                  Boolean(save.error) &&
                  save.input?.server.baseUrl === server.baseUrl &&
                  save.input.modelId === modelId;
                return (
                  <li key={modelId} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-body text-foreground">{label}</span>
                      <Button
                        size="sm"
                        className="ml-auto rounded-full"
                        aria-label={connected ? t`Connected ${label}` : t`Connect ${label}`}
                        disabled={connected || save.pending}
                        onClick={() => save.run({ server, modelId })}
                      >
                        {connected ? t`Connected` : t`Connect`}
                      </Button>
                    </div>
                    {failed ? (
                      <p className="text-body text-destructive" role="alert">
                        {errorText(save.error, t`Could not connect this provider`)}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/**
 * The models on this computer: the model servers running here, and open-weight models that would
 * fit it. Only a server that may reach this computer's addresses shows it; a hosted one never does.
 */
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
  const queries = useSpaceQueries();
  // Read again on focus: a server started in another window shows when the person comes back.
  const found = useQuery({
    ...queries.dozoLocalModels.servers.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  // The estimator detects nothing until the first open; after that it keeps its state while folded.
  const [opened, setOpened] = useState(false);
  if (!found.data?.available) return null;
  return (
    <Disclosure
      className="text-body text-foreground"
      summary={t`Run on this computer`}
      onOpenChange={(open) => {
        if (open) setOpened(true);
      }}
    >
      <LocalServers
        servers={found.data.servers}
        onConnected={onConnected}
        scope={scope}
        makeDefault={makeDefault}
      />
      {/* Until a person has recorded a tool-calling check there is nothing to suggest. */}
      {opened && models.length > 0 ? (
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
