import type { ReadPermission } from "./dozo-phone-read-permission";

// Android only (dozo-phone-write-permission.android.ts). Elsewhere the calendar module asks, and
// iOS's full calendar access covers adding events.
export const writePermission: ReadPermission | null = null;
