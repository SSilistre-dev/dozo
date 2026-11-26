import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoClientDiagnostics, DozoFeedbackStatus } from "@rakazo/contracts";
import {
  DOZO_FEEDBACK_MAX_CHARS,
  DOZO_FEEDBACK_MAX_IMAGES,
  dozoFeedbackFooter,
  dozoFeedbackText,
} from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Disclosure,
  Switch,
  Textarea,
  toast,
} from "@rakazo/ui-web";
import { ImagePlus, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { downloadArtifactBytes } from "../lib/pages/artifact-open";
import { desktopBridge } from "../lib/platform/desktop";
import { errorText } from "../lib/dozo-error-text";
import type { FeedbackImage } from "../lib/dozo-feedback-images";
import {
  addFeedbackImages,
  FEEDBACK_IMAGE_ACCEPT,
  feedbackImageBytes,
} from "../lib/dozo-feedback-images";
import { useSave } from "../lib/query/query";
import { useFeedbackStatus } from "./dozo-feedback";

/** What the app says about itself: surface, browser, language and time zone, nothing else. */
export function clientDiagnostics(view: Window = window): DozoClientDiagnostics {
  return {
    surface: desktopBridge() ? "desktop" : "web",
    userAgent: view.navigator.userAgent.slice(0, 300),
    language: view.navigator.language.slice(0, 35),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone.slice(0, 64),
  };
}

/**
 * A note, up to three pictures and, when switched on, the diagnostics. The lines added under the
 * note are shown before anything leaves: the server mails exactly those with the pictures, or,
 * without mail, the person saves the report and the pictures and writes to the operator's address
 * themselves.
 */
export function DozoFeedbackDialog({ onClose }: { onClose: () => void }) {
  const status = useFeedbackStatus();
  if (!status?.mode) return null;
  return <FeedbackForm status={status} onClose={onClose} />;
}

function FeedbackForm({ status, onClose }: { status: DozoFeedbackStatus; onClose: () => void }) {
  const { t } = useLingui();
  const switchId = useId();
  const [message, setMessage] = useState("");
  const [withDiagnostics, setWithDiagnostics] = useState(false);
  const [client] = useState(clientDiagnostics);
  const [images, setImages] = useState<FeedbackImage[]>([]);
  const [refused, setRefused] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const add = async (files: File[]) => {
    if (!files.length) return;
    const next = await addFeedbackImages(images, files);
    setImages(next.images);
    setRefused(next.refused);
  };
  const diagnostics = withDiagnostics ? { ...client, ...status.server } : null;
  const save = useSave({
    save: (_input, rpc) =>
      rpc.dozoFeedback.send({
        message,
        ...(images.length ? { images: images.map((image) => image.url) } : {}),
        ...(withDiagnostics
          ? { diagnostics: { client, runIds: status.server.failedRuns.map((run) => run.id) } }
          : {}),
      }),
    onSaved: () => {
      toast(t`Sent`);
      onClose();
    },
    closesScreen: true,
  });
  const empty = !message.trim();

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        data-testid="dozo-feedback"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void add([...event.dataTransfer.files]);
        }}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Send feedback</Trans>
          </DialogTitle>
        </DialogHeader>
        <Textarea
          aria-label={t`Feedback`}
          placeholder={t`What happened?`}
          rows={5}
          maxLength={DOZO_FEEDBACK_MAX_CHARS}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length) {
              event.preventDefault();
              void add(files);
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          {images.map((image, index) => (
            <span key={`${index}-${image.name}`} className="relative">
              <img
                src={image.url}
                alt=""
                className="size-10 rounded-md border border-border object-cover"
              />
              <button
                type="button"
                aria-label={t`Remove image`}
                className="absolute -end-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-foreground text-background"
                onClick={() => setImages(images.filter((_, at) => at !== index))}
              >
                <X className="size-3" strokeWidth={2} />
              </button>
            </span>
          ))}
          {images.length < DOZO_FEEDBACK_MAX_IMAGES ? (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={() => picker.current?.click()}
            >
              <ImagePlus strokeWidth={1.75} />
              <Trans>Add image</Trans>
            </Button>
          ) : null}
          <input
            ref={picker}
            type="file"
            hidden
            multiple
            accept={FEEDBACK_IMAGE_ACCEPT}
            data-testid="dozo-feedback-file"
            onChange={(event) => {
              void add([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
        </div>
        <label htmlFor={switchId} className="flex items-center gap-2.5 text-body">
          <Switch id={switchId} checked={withDiagnostics} onCheckedChange={setWithDiagnostics} />
          <Trans>Include diagnostics</Trans>
        </label>
        <Disclosure
          summary={<Trans>What's sent</Trans>}
          summaryClassName="text-body-sm text-muted-foreground"
        >
          <pre
            data-testid="dozo-feedback-preview"
            className="mt-2 max-h-40 overflow-auto rounded-md bg-muted p-2.5 text-label whitespace-pre-wrap break-all text-muted-foreground"
          >
            {dozoFeedbackFooter(status.from, diagnostics, images.length)}
          </pre>
        </Disclosure>
        {refused ? (
          <p role="alert" className="text-body-sm text-destructive">
            <Trans>Couldn't use that image</Trans>
          </p>
        ) : null}
        {save.error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {errorText(save.error, t`Could not send`)}
          </p>
        ) : null}
        <DialogFooter>
          {status.mode === "send" ? (
            <Button disabled={empty || save.pending} onClick={() => save.run()}>
              <Trans>Send</Trans>
            </Button>
          ) : (
            <>
              <p className="me-auto self-center text-body-sm text-muted-foreground">
                <a className="underline" href={`mailto:${status.address}`}>
                  {status.address}
                </a>
              </p>
              <Button
                disabled={empty}
                onClick={() => {
                  downloadArtifactBytes(
                    "feedback.txt",
                    "text/plain",
                    new TextEncoder().encode(
                      dozoFeedbackText(message, status.from, diagnostics, images.length),
                    ),
                  );
                  for (const image of images)
                    downloadArtifactBytes(
                      image.name,
                      image.url.slice(5, image.url.indexOf(";")),
                      feedbackImageBytes(image),
                    );
                }}
              >
                <Trans>Save</Trans>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
