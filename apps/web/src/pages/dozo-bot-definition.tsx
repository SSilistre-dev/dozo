import { Trans } from "@lingui/react/macro";
import { BotAvatar, SectionHeading } from "@rakazo/ui-web";
import type { ReactNode } from "react";

export type DozoBotShown = {
  name: string;
  color: string | null;
  instructions: string;
  description?: string;
  routines: { name: string; schedule?: string }[];
};

/**
 * A shared bot as its words stand: plain text, never Markdown or markup, because every word came
 * from a person or a bot. Empty parts are left out.
 */
export function DozoBotDefinition({ bot }: { bot: DozoBotShown }) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex items-center gap-3">
        <BotAvatar color={bot.color ?? ""} identity={bot.name} size={48} />
        <SectionHeading as="h2" variant="heading" className="min-w-0 break-words">
          {bot.name}
        </SectionHeading>
      </div>
      {bot.instructions ? (
        <Part label={<Trans>Instructions</Trans>}>
          <p className="whitespace-pre-wrap break-words">{bot.instructions}</p>
        </Part>
      ) : null}
      {bot.description ? (
        <Part label={<Trans>How other bots see it</Trans>}>
          <p className="whitespace-pre-wrap break-words">{bot.description}</p>
        </Part>
      ) : null}
      {bot.routines.length ? (
        <Part label={<Trans>Routines</Trans>}>
          <ul className="flex flex-col gap-1">
            {bot.routines.map((routine, index) => (
              // Two routines may share a name; the list never reorders while shown.
              <li key={index} className="break-words">
                {routine.name}
                {routine.schedule ? (
                  <span className="text-muted-foreground"> · {routine.schedule}</span>
                ) : null}
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
