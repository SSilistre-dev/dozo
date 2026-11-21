import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { DOZO_AVATAR_GENERATE_ERRORS, DOZO_AVATAR_PROMPT_MAX_CHARS } from "@rakazo/contracts";
import { BotAvatar, TabsContent, TabsTrigger } from "@rakazo/ui-web";
import { Button } from "@rakazo/ui-web/components/ui/button";
import { Textarea } from "@rakazo/ui-web/components/ui/textarea";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { useContext, useEffect, useRef, useState } from "react";
import { Shimmer } from "../../components/ai/primitives";
import { errorText } from "../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../lib/query";
import { errorCode } from "../../lib/user-error";

/** The studio tab that holds the description field and the picture drawn from it. */
export const DOZO_AVATAR_GENERATE_TAB = "generate";

/**
 * Whether this server can draw an avatar from a description for this person. Read when the studio
 * opens, never polled. Without a query client (a page that renders the studio bare) or while the
 * read is out or failed, it is not on offer.
 */
function useAvatarGenerateAvailable(): boolean {
  const queries = useSpaceQueries();
  const status = useQuery(queries.dozoAvatarGenerate.status.queryOptions());
  return status.data?.available === true;
}

function WithStatus({ children }: { children: React.ReactNode }) {
  return useAvatarGenerateAvailable() ? children : null;
}

function WhenQueriesExist({ children }: { children: React.ReactNode }) {
  return useContext(QueryClientContext) ? <WithStatus>{children}</WithStatus> : null;
}

/** The third way beside Bot and Upload; absent unless drawing is on offer. */
export function DozoAvatarGenerateTab() {
  return (
    <WhenQueriesExist>
      <TabsTrigger value={DOZO_AVATAR_GENERATE_TAB} className="rounded-full px-3 text-label">
        <Trans>Generate</Trans>
      </TabsTrigger>
    </WhenQueriesExist>
  );
}

export function DozoAvatarGeneratePanel({ onUse }: { onUse: (image: string) => void }) {
  return (
    <WhenQueriesExist>
      <TabsContent value={DOZO_AVATAR_GENERATE_TAB}>
        <Generator onUse={onUse} />
      </TabsContent>
    </WhenQueriesExist>
  );
}

function Generator({ onUse }: { onUse: (image: string) => void }) {
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
    onSaved: (result) => setImage(result.image),
  });
  // Another picture is already being drawn for this person: this one goes back to waiting.
  const error =
    generate.error && errorCode(generate.error) !== DOZO_AVATAR_GENERATE_ERRORS.busy
      ? generate.error
      : null;
  const description = prompt.trim();
  const run = () => {
    if (description) generate.run(description);
  };
  return (
    <div className="flex flex-col gap-3">
      <Textarea
        value={prompt}
        maxLength={DOZO_AVATAR_PROMPT_MAX_CHARS}
        disabled={generate.pending}
        aria-label={t`Describe the avatar`}
        placeholder={t`Describe the avatar`}
        data-testid="avatar-generate-prompt"
        onChange={(event) => setPrompt(event.target.value)}
      />
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
          </div>
        </div>
      ) : (
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
      )}
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(error)}
        </p>
      ) : null}
    </div>
  );
}
