import { Trans } from "@lingui/react/macro";
import type { DozoBotDefinition as Definition } from "@rakazo/contracts";
import { BotAvatar, SectionHeading } from "@rakazo/ui-web";
import type { ReactNode } from "react";

export type DozoBotShown = {
  name: string;
  color: string | null;
  instructions: string;
  description?: string;
  routines: { name: string; schedule?: string; prompt?: string }[];
};

/** Everything a definition publishes or copies, each part whole: nothing it holds goes unseen. */
export function dozoBotShown(definition: Definition): DozoBotShown {
  return {
    ...definition,
    color: definition.avatar.color,
    routines: definition.routines.map((routine) => ({
      name: routine.name,
      schedule: routine.crons.join(", "),
      prompt: routine.prompt,
    })),
  };
}

/**
 * A shared bot as its words stand: plain text, never Markdown or markup, because every word came
 * from a person or a bot, and whole, never cut or folded. Each part takes its own text direction,
 * so one part's right-to-left text cannot reorder the next. Empty parts are left out.
 */
export function DozoBotDefinition({ bot }: { bot: DozoBotShown }) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex items-center gap-3">
        <BotAvatar color={bot.color ?? ""} identity={bot.name} size={48} />
        <SectionHeading as="h2" variant="heading" dir="auto" className="min-w-0 break-words">
          {bot.name}
        </SectionHeading>
      </div>
      {bot.instructions ? (
        <Part label={<Trans>Instructions</Trans>}>
          <Text>{bot.instructions}</Text>
        </Part>
      ) : null}
      {bot.description ? (
        <Part label={<Trans>How other bots see it</Trans>}>
          <Text>{bot.description}</Text>
        </Part>
      ) : null}
      {bot.routines.length ? (
        <Part label={<Trans>Routines</Trans>}>
          <ul className="flex flex-col gap-3">
            {bot.routines.map((routine, index) => (
              // Two routines may share a name; the list never reorders while shown.
              <li key={index} className="flex flex-col gap-0.5">
                <span dir="auto" className="break-words font-medium">
                  {routine.name}
                </span>
                {routine.schedule ? (
                  <span dir="auto" className="text-body-sm text-muted-foreground">
                    {routine.schedule}
                  </span>
                ) : null}
                {routine.prompt ? <Text>{routine.prompt}</Text> : null}
              </li>
            ))}
          </ul>
        </Part>
      ) : null}
    </div>
  );
}

function Part({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 text-body">
      <SectionHeading variant="label">{label}</SectionHeading>
      {children}
    </section>
  );
}

function Text({ children }: { children: string }) {
  return (
    <p dir="auto" className="whitespace-pre-wrap break-words">
      {children}
    </p>
  );
}
