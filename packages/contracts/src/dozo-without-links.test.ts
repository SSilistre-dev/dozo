import { describe, expect, it } from "vitest";
import { withoutLinks } from "./dozo-without-links.js";

describe("withoutLinks", () => {
  it.each([
    ["meet.google.com", undefined],
    ["Video: meet.google.com/abc-defg-hij", "Video:"],
    ["zoom.us / j / 123", undefined],
    ["Join zoom.us", "Join"],
    ["zoom．us／j／123", undefined],
    ["Call tel:+1 555 0100,,123456# now", "Call now"],
    ["Standup https://x.example/j/1?pwd=abc", "Standup"],
    ["Sync www.example.test/room?id=4 at noon", "Sync at noon"],
    ["Office example.test:8443/a?b=c", "Office"],
    ["  Lunch　 with   Ada ", "Lunch with Ada"],
  ])("takes the link out of %j", (text, kept) => {
    expect(withoutLinks(text)).toBe(kept);
  });

  it.each([
    "Passcode: abc123",
    "Meeting ID 123 4567 8901",
    "Room 4.2",
    "Main St. 12/3, Berlin",
    "St. James's Park",
    "Dr. Smith",
    "Coffee at 10.30",
    "Time:10:30",
    "Re:Budget",
    "Ship v2.1",
    "Node.js meetup",
    "ASP.NET review",
    "Mail ada@example.test",
  ])("leaves %j as written", (text) => {
    expect(withoutLinks(text)).toBe(text);
  });

  it("gives nothing for text that was only a link or space", () => {
    expect(withoutLinks("https://x.example")).toBeUndefined();
    expect(withoutLinks("   ")).toBeUndefined();
  });
});
