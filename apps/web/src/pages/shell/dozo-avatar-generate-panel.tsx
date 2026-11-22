import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { DOZO_AVATAR_PROMPT_MAX_CHARS } from "@rakazo/contracts";
import { BotAvatar, TabsContent } from "@rakazo/ui-web";
import { Button } from "@rakazo/ui-web/components/ui/button";
import { Textarea } from "@rakazo/ui-web/components/ui/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Shimmer } from "../../components/ai/primitives";
import { errorText } from "../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../lib/query";
import { DOZO_AVATAR_GENERATE_TAB, WhenQueriesExist } from "./dozo-avatar-generate";

/** The studio's Generate tab, loaded when the studio opens (dozo-avatar-generate.tsx holds its tab). */
export function DozoAvatarGeneratePanel({ onUse }: { onUse: (image: string) => void }) {
  return (
    <WhenQueriesExist>
      {(available) => (
        <TabsContent value={DOZO_AVATAR_GENERATE_TAB}>
          <Generator available={available} onUse={onUse} />
        </TabsContent>
      )}
    </WhenQueriesExist>
  );
}

/**
 * `available` is whether another picture may be drawn: once it is not (the day's allowance was just
 * used), a picture already drawn can still be used, but nothing more is offered.
 */
function Generator({ available, onUse }: { available: boolean; onUse: (image: string) => void }) {
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const statusKey = queries.dozoAvatarGenerate.status.queryOptions().queryKey;
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  // Leaving the tab or the studio drops the request in flight and its answer.
  useEffect(() => () => request.current?.abort(), []);
  const generate = useSave({
    save: async (description: string, rpc) => {
      const controller = new AbortController();
      request.current = controller;
      return rpc.dozoAvatarGenerate.generate(
        { prompt: description },
        { signal: controller.signal },
      );
    },
    stale: [statusKey],
    onSaved: (result) => setImage(result.image),
    // A refusal (the allowance is used up, no plan) changes what is on offer as much as a picture does.
    onFailed: () => void queryClient.invalidateQueries({ queryKey: statusKey }),
  });
  const description = prompt.trim();
  const run = () => {
    if (description) generate.run(description);
  };
  if (!available && !image && !generate.error) return null;
  return (
    <div className="flex flex-col gap-3">
      {available ? (
        <Textarea
          value={prompt}
          maxLength={DOZO_AVATAR_PROMPT_MAX_CHARS}
          disabled={generate.pending}
          aria-label={t`Describe the avatar`}
          placeholder={t`Describe the avatar`}
          data-testid="avatar-generate-prompt"
          onChange={(event) => setPrompt(event.target.value)}
        />
      ) : null}
      {image ? (
        <div className="flex flex-col items-center gap-3">
          <BotAvatar color={image} size={72} />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="avatar-generate-use"
              onClick={() => onUse(image)}
            >
              <Trans>Use</Trans>
            </Button>
            {available ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={generate.pending || !description}
                onClick={run}
              >
                {generate.pending ? (
                  <Shimmer>
                    <Trans>Try again</Trans>
                  </Shimmer>
                ) : (
                  <Trans>Try again</Trans>
                )}
              </Button>
            ) : null}
          </div>
        </div>
      ) : available ? (
        <Button
          type="button"
          size="sm"
          className="self-end"
          disabled={generate.pending || !description}
          data-testid="avatar-generate-submit"
          onClick={run}
        >
          {generate.pending ? (
            <Shimmer>
              <Trans>Generate</Trans>
            </Shimmer>
          ) : (
            <Trans>Generate</Trans>
          )}
        </Button>
      ) : null}
      {generate.error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(generate.error)}
        </p>
      ) : null}
    </div>
  );
}
