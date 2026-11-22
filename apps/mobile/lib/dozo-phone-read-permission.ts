/** Reading the calendar on its own, where the system asks for that apart from writing. */
export type ReadPermission = { check(): Promise<boolean>; request(): Promise<boolean> };

// Android only (dozo-phone-read-permission.android.ts). Elsewhere the calendar module asks.
export const readPermission: ReadPermission | null = null;
