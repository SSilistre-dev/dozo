import { Trans, useLingui } from "@lingui/react/macro";
import { DOZO_DEFAULT_DIGEST_MINUTE } from "@rakazo/contracts";
import { Label, NativeSelect, NativeSelectOption, Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query/query";
import { SettingsRow } from "./settings/SettingsRows";

const HOUR_MINUTES = Array.from({ length: 24 }, (_, hour) => hour * 60);

type Digest = { botId: string; minute: number } | null;

/**
 * The account's daily digest, under quiet hours in General settings: once a day, at the chosen
 * time, one bot's chat gets what happened, what is waiting and what is due. Off shows the switch
 * alone; on adds the time, and the bot when there is more than one to pick.
 */
export function DozoDailyDigestRow() {
  const { t, i18n } = useLingui();
  const switchId = useId();
  const queries = useSpaceQueries();
  const read = useQuery({
    ...queries.dozoDailyDigest.get.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  const bots = useQuery(queries.bots.list.queryOptions());
  const save = useSave({
    save: (digest: Digest, rpc) => rpc.dozoDailyDigest.set({ digest }),
    stale: [queries.dozoDailyDigest.get.key()],
    onFailed: (error) => toastError(t`Couldn't update the daily digest`, error),
  });
  const saved = read.data?.digest ?? null;
  const digest = save.pending
    ? save.input
      ? { ...save.input, botName: saved?.botName ?? "" }
      : null
    : saved;
  const firstBot = bots.data?.[0];
  if (!digest && !firstBot) return null;
  const time = new Intl.DateTimeFormat(i18n.locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const label = (minute: number) => time.format(new Date(Date.UTC(2000, 0, 1, 0, minute)));
  const minutes =
    digest?.minute == null || HOUR_MINUTES.includes(digest.minute)
      ? HOUR_MINUTES
      : [...HOUR_MINUTES, digest.minute].sort((a, b) => a - b);
  const botOptions = (bots.data ?? []).map((bot) => ({ id: bot.id, name: bot.name }));
  if (digest && !botOptions.some((bot) => bot.id === digest.botId))
    botOptions.unshift({ id: digest.botId, name: digest.botName });
  return (
    <div data-testid="dozo-daily-digest">
      <SettingsRow
        label={
          <Label htmlFor={switchId} className="text-body font-normal text-foreground">
            <Trans>Daily digest</Trans>
          </Label>
        }
        control={
          <Switch
            id={switchId}
            checked={digest !== null}
            disabled={read.isPending || read.isError || save.pending}
            onCheckedChange={(on) =>
              save.run(
                on && firstBot ? { botId: firstBot.id, minute: DOZO_DEFAULT_DIGEST_MINUTE } : null,
              )
            }
          />
        }
      >
        {digest ? (
          <div className="mt-2 flex items-center justify-end gap-2">
            {botOptions.length > 1 ? (
              <NativeSelect
                aria-label={t`Daily digest bot`}
                value={digest.botId}
                disabled={save.pending}
                onChange={(event) =>
                  save.run({
                    botId: event.target.value,
                    minute: digest.minute ?? DOZO_DEFAULT_DIGEST_MINUTE,
                  })
                }
                className="w-40"
              >
                {botOptions.map((bot) => (
                  <NativeSelectOption key={bot.id} value={bot.id}>
                    {bot.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : null}
            <NativeSelect
              aria-label={t`Daily digest time`}
              value={digest.minute == null ? "" : String(digest.minute)}
              disabled={save.pending}
              onChange={(event) =>
                save.run({ botId: digest.botId, minute: Number(event.target.value) })
              }
              className="w-28"
            >
              {digest.minute == null ? <NativeSelectOption value="" disabled /> : null}
              {minutes.map((minute) => (
                <NativeSelectOption key={minute} value={String(minute)}>
                  {label(minute)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
      </SettingsRow>
    </div>
  );
}
