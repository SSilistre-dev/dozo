import type { DozoClientDiagnostics } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Platform } from "react-native";
import { queryClient, rpcQuery } from "./query/query";
import { deviceTimeZone } from "./routines/routine";

/** What the app says about itself: surface, system, language and time zone, nothing else. */
export function mobileDiagnostics(): DozoClientDiagnostics {
  return {
    surface: "mobile",
    userAgent: `Dozo ${Platform.OS} ${Platform.Version}`.slice(0, 300),
    language: Intl.DateTimeFormat().resolvedOptions().locale.slice(0, 35),
    timeZone: (deviceTimeZone() ?? "UTC").slice(0, 64),
  };
}

/** The first line of a report from a message's menu: which message, as the operator finds it. */
export function reportLine(threadId: string, messageId: string): string {
  return `Reported message ${messageId} in chat ${threadId}`;
}

/** Where feedback goes on this server; nothing while it is loading or not set up. */
export function useFeedbackStatus() {
  return useQuery({ ...rpcQuery("dozoFeedback/status"), refetchOnMount: "always" }, queryClient)
    .data;
}
