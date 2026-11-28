import { Trans } from "@lingui/react/macro";
import { DozoStatsCardSchema } from "@rakazo/contracts";
import { BotAvatar } from "@rakazo/ui-web";

/** The signed-out page of a stats link: the bot's face, its name and its numbers, drawn as text. */
export function DozoStatsCard({ payload }: { payload: unknown }) {
  const card = DozoStatsCardSchema.safeParse(payload);
  if (!card.success) return null;
  const { name, character, color, stats } = card.data;
  const numbers = [
    { key: "tasks", label: <Trans>Tasks</Trans>, value: stats.tasksFinished },
    { key: "routines", label: <Trans>Routine runs</Trans>, value: stats.routineRuns },
    { key: "skills", label: <Trans>Skills</Trans>, value: stats.skillsLearned },
    { key: "days", label: <Trans>Days active</Trans>, value: stats.daysActive },
  ];
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
      <section className="flex w-full max-w-xs flex-col items-center gap-8">
        <BotAvatar identity={character} color={color ?? "#ffffff"} size={96} />
        <h1 className="max-w-full truncate text-2xl font-medium">{name}</h1>
        <dl className="grid w-full grid-cols-2 gap-x-6 gap-y-6 text-center">
          {numbers.map(({ key, label, value }) => (
            <div key={key} className="flex flex-col-reverse">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-3xl font-medium tabular-nums">{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
