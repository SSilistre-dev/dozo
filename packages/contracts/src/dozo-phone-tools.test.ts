import { describe, expect, it } from "vitest";
import { isPhoneToolName, isPhoneWriteToolName, oneLineText } from "./dozo-phone-tools.js";

describe("oneLineText", () => {
  it.each([
    ["Ada\nLovelace", "Ada Lovelace"],
    ["  Ada \r\n\t Lovelace  ", "Ada Lovelace"],
    [`Ada${"\n".repeat(500)}Lovelace`, "Ada Lovelace"],
    ["Ada  Lovelace", "Ada Lovelace"],
    ["Ａｄａ", "Ada"],
    // Bidi controls, zero-width characters and other control characters are dropped.
    ["‮Ada‬ ⁦Love​lace⁩", "Ada Lovelace"],
    ["A\u0000d\u0007a\u007F\u0085", "Ada"],
    ["李明", "李明"],
    ["\n\t​", ""],
  ])("makes %j one line", (text, line) => {
    expect(oneLineText(text)).toBe(line);
  });
});

describe("isPhoneToolName", () => {
  it("knows the phone tools only", () => {
    expect(isPhoneToolName("phone_location")).toBe(true);
    expect(isPhoneToolName("web_search")).toBe(false);
  });
});

describe("isPhoneWriteToolName", () => {
  it("knows the tools that create something on the phone", () => {
    for (const name of ["phone_calendar_create", "phone_reminder_create"]) {
      expect(isPhoneWriteToolName(name)).toBe(true);
      expect(isPhoneToolName(name)).toBe(true);
    }
    expect(isPhoneToolName("phone_reminders_read")).toBe(true);
    expect(isPhoneWriteToolName("phone_reminders_read")).toBe(false);
    expect(isPhoneWriteToolName("phone_calendar_read")).toBe(false);
  });
});
