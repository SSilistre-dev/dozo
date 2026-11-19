import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { planHasNoComputer } from "@rakazo/contracts";
import { Button, Label, Popover, PopoverContent, PopoverTrigger, Textarea } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, useRef, useState } from "react";
import { useBilling } from "../../components/SubscriptionGate";
import { runsOnUserMachine } from "../../lib/computer-sandbox";
import { useSave, useSpaceQueries } from "../../lib/query";
import { errorText } from "../../lib/user-error";
import { PanelSection } from "./bot-settings-sections";
import { ComputerPanel } from "./computer-panel";

/**
 * The bot panel's skills: the ones taught and saved, and Teach a task. Starting opens the bot's
 * computer the way the panel's own Wake does, which loads the recording and shows its chrome.
 * `computer` is the panel's computer section; without it, or on a plan with no computer or a
 * computer on the person's own machine, there is nothing to teach on and nothing shows.
 * Where the deployment bills, nothing shows either until its plan is known.
 */
export function DozoBotSkillsSection({ bot, computer }: { bot: Bot; computer: ReactNode }) {
  const billing = useBilling().status;
  const me = useQuery(useSpaceQueries().me.queryOptions()).data;
  const panel =
    isValidElement<ComponentProps<typeof ComputerPanel>>(computer) &&
    computer.type === ComputerPanel
      ? computer.props
      : null;
  // No status means no billing, or a lookup that failed: only the first may teach unchecked.
  const planKnown = me !== undefined && (billing !== null || !me.billingEnabled);
  if (!panel || !planKnown || planHasNoComputer(billing) || runsOnUserMachine(panel.computer)) {
    return null;
  }
  return <SkillsSection botId={bot.id} onOpen={panel.onOpen} />;
}

function SkillsSection({ botId, onOpen }: { botId: string; onOpen: () => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const skills = useQuery(queries.skills.list.queryOptions({ input: { botId } }));
  const saved = (skills.data ?? []).filter((skill) => skill.status === "saved");
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  // Once recording starts, focus must not go back to the trigger: the recording ignores keys
  // typed into a button, so the first text of the demonstration would be lost.
  const started = useRef(false);
  const start = useSave({
    save: async (text: string, rpc) => {
      await rpc.computer.boot({ botId });
      try {
        return await rpc.skills.start({ botId, goal: text });
      } catch (error) {
        // The answer can be lost while the recording did start (the network flaps as the
        // computer boots): a live recording for this bot means it started. If the re-read
        // fails too, the start's own error is the one to show.
        const skills = await rpc.skills.list({ botId }).catch(() => {
          throw error;
        });
        const recording = skills.find((skill) => skill.status === "recording");
        if (recording) return recording;
        throw error;
      }
    },
    onSaved: () => {
      started.current = true;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setOpen(false);
      setGoal("");
      onOpen();
    },
  });

  function close() {
    start.reset();
    setOpen(false);
  }

  function show() {
    started.current = false;
    setOpen(true);
  }

  return (
    <PanelSection
      label={<Trans>Skills</Trans>}
      action={
        <Popover open={open} onOpenChange={(next) => (next ? show() : close())}>
          <PopoverTrigger
            data-testid="dozo-teach-start"
            render={<Button variant="ghost" size="xs" />}
          >
            <Trans>Teach a task</Trans>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            className="w-[min(360px,calc(100vw-2rem))]"
            finalFocus={() => !started.current}
          >
            <Label
              htmlFor={`dozo-teach-goal-${botId}`}
              className="text-body-sm font-normal text-muted-foreground"
            >
              <Trans>What result will you demonstrate?</Trans>
            </Label>
            <Textarea
              id={`dozo-teach-goal-${botId}`}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={3}
              placeholder={t`Export this week's list from the CRM and drop it in the shared folder`}
            />
            {start.error ? (
              <div role="alert" className="text-body-sm text-destructive">
                {errorText(start.error, t`Could not start teaching`)}
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                disabled={start.pending || !goal.trim()}
                onClick={() => start.run(goal.trim())}
              >
                {start.pending ? <Trans>Starting…</Trans> : <Trans>Start recording</Trans>}
              </Button>
              <Button variant="outline" onClick={close}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      }
    >
      {saved.length ? (
        <ul className="flex flex-col gap-1">
          {saved.map((skill) => (
            <li key={skill.id} dir="auto" className="truncate text-body text-foreground">
              {skill.name || skill.goal}
            </li>
          ))}
        </ul>
      ) : null}
    </PanelSection>
  );
}
