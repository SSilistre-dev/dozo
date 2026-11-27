import { t } from "@lingui/core/macro";

const FOCUS_QUESTION = "What do you want me on first?";

/** The server stores the first-run focus card in English; the app translates it, as the web app does. */
export function dozoFocusQuestion(question: string): string {
  return question === FOCUS_QUESTION ? t`What do you want me on first?` : question;
}

export function dozoFocusOptionLabel(question: string, id: string, label: string): string {
  if (question !== FOCUS_QUESTION) return label;
  switch (id) {
    case "day":
      return t`Day-to-day work`;
    case "inbox":
      return t`Inbox & email`;
    case "research":
      return t`Research & writing`;
    case "everything":
      return t`A bit of everything`;
    default:
      return label;
  }
}
