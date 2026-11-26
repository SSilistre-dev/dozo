import { expect, it, vi } from "vitest";
import { useOwnComputerSwitch } from "./dozo-own-computer";
import { usePlanLimitNotice } from "./dozo-plan-limit";
import { queryClient } from "./query/query";

// The mobile app has no QueryClientProvider: a read must be handed the shared client itself.

const clients = vi.hoisted(() => ({ used: [] as unknown[] }));
vi.mock("./query/query", () => ({
  rpcQuery: (proc: string) => ({ queryKey: [proc] }),
  queryClient: { shared: true },
}));
vi.mock("./api/api", () => ({ currentApiBase: () => "https://dozo.example.invalid" }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() } }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (_options: unknown, client: unknown) => {
    clients.used.push(client);
    return { data: undefined };
  },
}));

it("the computer hooks read through the app's shared query client", () => {
  useOwnComputerSwitch("team", { spaceId: "space", userId: "maker" });
  usePlanLimitNotice("No computer hours left.");
  expect(clients.used).toHaveLength(4);
  expect(clients.used.every((client) => client === queryClient)).toBe(true);
});
