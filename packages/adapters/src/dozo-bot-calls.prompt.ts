/**
 * Added to `call_user` in a routine's or watch's run, where the person is not in the chat.
 * The limits (quiet hours, cooldown, daily cap) are enforced in code and arrive as refusals.
 */
export const ROUTINE_CALL_GUIDANCE =
  "From a routine or watch, call only when the routine's own instructions mark the matter as urgent or time-critical; for anything else leave a message. If the call is refused, leave a message instead.";
