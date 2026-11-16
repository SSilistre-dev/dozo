import { useLingui } from "@lingui/react/macro";
import { Button, useCopyText } from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { LOCAL_RUNTIME } from "../lib/dozo-local-model-catalog";
import type { LocalModelFit } from "../lib/dozo-local-model-fit";
import { LOCAL_MODEL_CONTEXT_TOKENS } from "../lib/dozo-local-model-fit";
import { errorText } from "../lib/user-error";

const oneDecimal = (value: number) => Number(value.toFixed(1));

/** A connection is one model on one server: the same model on another address is a new one. */
export function connectionKey(baseUrl: string, modelId: string): string {
  return `${baseUrl.trim()}\n${modelId}`;
}

function CopyCommand({ text, label }: { text: string; label: string }) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <Button
      variant="outline"
      size="sm"
      className="rounded-full"
      aria-label={t`Copy ${label}`}
      onClick={() => void copy(text)}
    >
      {copied ? <Check /> : <Copy />}
      {t`Copy`}
    </Button>
  );
}

function LocalModelRow({
  fit: { model, tokensPerSecond },
  command,
  connected,
  disabled,
  errorMessage,
  onConnect,
}: {
  fit: LocalModelFit;
  command: string;
  connected: boolean;
  disabled: boolean;
  errorMessage: string | null;
  onConnect: () => void;
}) {
  const { t } = useLingui();
  const label = model.label;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body text-foreground">{label}</span>
        <span className="text-body text-muted-foreground">
          {t`${Math.round(tokensPerSecond)} tok/s`}
        </span>
        <span className="text-body text-muted-foreground">
          {t`${oneDecimal(model.weightsGB)} GB`}
        </span>
        <span className="ml-auto flex gap-2">
          <CopyCommand text={command} label={label} />
          <Button
            size="sm"
            className="rounded-full"
            aria-label={connected ? t`Connected ${label}` : t`Connect ${label}`}
            disabled={disabled}
            onClick={onConnect}
          >
            {connected ? t`Connected` : t`Connect`}
          </Button>
        </span>
      </div>
      {errorMessage === null ? null : (
        <p className="text-body text-destructive" role="alert">
          {errorMessage}
        </p>
      )}
    </li>
  );
}

/** The suggested models, each with its copy and connect actions. */
export function LocalModelRows({
  rows,
  baseUrl,
  connectedKeys,
  pending,
  error,
  errorModelId,
  onConnect,
}: {
  rows: readonly LocalModelFit[];
  baseUrl: string;
  connectedKeys: readonly string[];
  pending: boolean;
  /** The last refusal, shown only beside the row it belongs to. */
  error: unknown;
  errorModelId: string | undefined;
  onConnect: (modelId: string) => void;
}) {
  const { t } = useLingui();
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((fit) => {
        const { command, modelId } = LOCAL_RUNTIME.prepare(
          fit.model.tag,
          LOCAL_MODEL_CONTEXT_TOKENS,
        );
        const connected = connectedKeys.includes(connectionKey(baseUrl, modelId));
        const failed = Boolean(error) && errorModelId === modelId;
        return (
          <LocalModelRow
            key={fit.model.id}
            fit={fit}
            command={command}
            connected={connected}
            disabled={connected || pending || !baseUrl.trim()}
            errorMessage={failed ? errorText(error, t`Could not connect this provider`) : null}
            onConnect={() => onConnect(modelId)}
          />
        );
      })}
    </ul>
  );
}
