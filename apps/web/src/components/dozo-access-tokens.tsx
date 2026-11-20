import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoAccessToken } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Check, Copy, Trash2 } from "lucide-react";
import { useState } from "react";
import { useCopyText } from "../lib/copy-text";
import { toastError } from "../lib/dozo-error-text";
import { queryClient, useSave, useSpaceQueries } from "../lib/query";
import { SettingsRow } from "./SettingsRows";

/**
 * Personal access tokens for the bot API, from Settings > General > Security: one row that opens
 * the member's tokens in the current Space. A new token is shown once, right after it is made.
 */
export function DozoAccessTokensRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsRow
        label={<Trans>Access tokens</Trans>}
        control={
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            <Trans>Manage</Trans>
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-testid="dozo-access-tokens"
          className="max-h-[calc(100%-4rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Access tokens</Trans>
            </DialogTitle>
          </DialogHeader>
          {open ? (
            // Its own provider, so the row also works where settings are shown without one.
            <QueryClientProvider client={queryClient}>
              <Tokens />
            </QueryClientProvider>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Tokens() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const tokens = useQuery({
    ...queries.dozoAccessTokens.list.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const revoke = useSave({
    save: (id: string, rpc) => rpc.dozoAccessTokens.revoke({ id }),
    stale: [queries.dozoAccessTokens.list.key()],
    onFailed: (error) => toastError(t`Could not revoke token`, error),
  });
  if (made) return <NewToken token={made} onDone={() => setMade(null)} />;
  if (creating)
    return (
      <CreateToken
        onCancel={() => setCreating(false)}
        onCreated={(token) => {
          setCreating(false);
          setMade(token);
        }}
      />
    );
  return (
    <div className="-mx-6 min-h-0 overflow-y-auto px-6">
      {tokens.data?.length ? (
        <ul className="divide-y divide-border">
          {tokens.data.map((token) => (
            <TokenRow
              key={token.id}
              token={token}
              disabled={revoke.pending}
              onRevoke={() => revoke.run(token.id)}
            />
          ))}
        </ul>
      ) : null}
      <Button variant="text" className="mt-1 font-normal" onClick={() => setCreating(true)}>
        <Trans>New token</Trans>
      </Button>
    </div>
  );
}

function TokenRow({
  token,
  disabled,
  onRevoke,
}: {
  token: DozoAccessToken;
  disabled: boolean;
  onRevoke: () => void;
}) {
  const { t, i18n } = useLingui();
  const name = token.name;
  const date =
    token.lastUsedAt &&
    new Date(token.lastUsedAt).toLocaleDateString(i18n.locale, { dateStyle: "medium" });
  const used = date ? t`Last used ${date}` : t`Never used`;
  return (
    <li data-testid="dozo-access-token" className="flex items-center gap-3 py-2.5 text-body">
      <div className="min-w-0 flex-1">
        <p className="truncate text-foreground">{name}</p>
        <p className="flex flex-wrap gap-x-3 text-body-sm text-muted-foreground">
          <span className="font-mono">…{token.hint}</span>
          {token.botName ? <span className="truncate">{token.botName}</span> : null}
          <span>{used}</span>
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t`Revoke ${name}`}
        className="text-destructive hover:text-destructive"
        disabled={disabled}
        onClick={onRevoke}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

function CreateToken({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (token: string) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const bots = useQuery(queries.bots.list.queryOptions());
  const [name, setName] = useState("");
  const [botId, setBotId] = useState("");
  const create = useSave({
    save: (input: { name: string; botId?: string }, rpc) => rpc.dozoAccessTokens.create(input),
    stale: [queries.dozoAccessTokens.list.key()],
    onSaved: (created) => onCreated(created.token),
    onFailed: (error) => toastError(t`Could not create token`, error),
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) create.run({ name: name.trim(), ...(botId ? { botId } : {}) });
      }}
    >
      <Input
        aria-label={t`Name`}
        placeholder={t`Name`}
        maxLength={60}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <NativeSelect
        aria-label={t`Bot`}
        className="w-full"
        value={botId}
        onChange={(event) => setBotId(event.target.value)}
      >
        <NativeSelectOption value="">{t`All bots`}</NativeSelectOption>
        {bots.data?.map((bot) => (
          <NativeSelectOption key={bot.id} value={bot.id}>
            {bot.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={!name.trim() || create.pending}>
          <Trans>Create</Trans>
        </Button>
      </div>
    </form>
  );
}

function NewToken({ token, onDone }: { token: string; onDone: () => void }) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 rounded-lg bg-muted py-0.5 pr-0.5 pl-2.5">
        <code data-testid="dozo-new-token" className="min-w-0 flex-1 break-all text-label">
          {token}
        </code>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? t`Copied` : t`Copy token`}
          onClick={() => copy(token)}
          className="text-muted-foreground"
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <p className="text-body-sm text-muted-foreground">
        <Trans>Copy it now. It won't be shown again.</Trans>
      </p>
      <div className="flex justify-end">
        <Button onClick={onDone}>
          <Trans>Done</Trans>
        </Button>
      </div>
    </div>
  );
}
