/**
 * Told to the bot when a skill's steps hold inputs (`{{name}}`): where each value comes from,
 * and that a secret one is never asked for in chat.
 */
export function skillInputsInstruction(inputs: Array<{ name: string; secret: boolean }>): string {
  const all = inputs.map((input) => `{{${input.name}}}`).join(", ");
  const secrets = inputs.filter((input) => input.secret).map((input) => `{{${input.name}}}`);
  return [
    `The steps use these inputs: ${all}. Take each one from the task or the user's message; if one is missing, ask the user for it before you start.`,
    secrets.length
      ? `Secret inputs (${secrets.join(", ")}): never ask for them in chat. Use a login saved with request_secret and type it with browser_act fill_secret.`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The values the person gave for this run, so the bot does not ask for them again. */
export function skillGivenInputs(values: Array<[name: string, value: string]>): string {
  return [
    "Given inputs:",
    ...values.map(([name, value]) => `- ${name}: ${JSON.stringify(value)}`),
  ].join("\n");
}
