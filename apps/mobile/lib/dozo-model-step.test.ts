import { Alert } from "react-native";
import { expect, it, vi } from "vitest";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("expo-router", () => ({ router: { replace } }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

import { askToAddModel } from "./dozo-model-step";

it("opens the model screen in place of an alert", () => {
  askToAddModel();
  expect(replace).toHaveBeenLastCalledWith("/(settings)/models");
  expect(Alert.alert).not.toHaveBeenCalled();
});

it("opens the model screen of the Space that overrides the account's", () => {
  askToAddModel("space-1");
  expect(replace).toHaveBeenLastCalledWith({
    pathname: "/(settings)/models",
    params: { spaceId: "space-1" },
  });
});
