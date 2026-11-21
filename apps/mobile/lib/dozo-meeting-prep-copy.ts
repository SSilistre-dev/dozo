import { t } from "@lingui/core/macro";
import type { BotTemplateCopy } from "./bot-template-copy";

/** The "Meeting prep" template's name, summary and sample in the app's language. */
export function dozoMeetingPrepCopy(): BotTemplateCopy {
  return {
    name: t`Meeting prep`,
    summary: t`A short prep note before each meeting`,
    sample: t`**Design review, 11:30**

With Priya, Sam and Dana (Acme)

**Agenda**
- Walk through the new onboarding flow
- Decide on the launch date
- Attached: onboarding-v3.pdf

**From before**
- Priya asked to cut the signup step on Tuesday
- Sam is still waiting on the API limits`,
  };
}
