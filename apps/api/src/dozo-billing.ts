import { ClientError } from "@rakazo/core";

/** A checkout was asked for a plan that has no price: the free one, which nobody pays for. */
export class PlanNotOfferedError extends ClientError {
  constructor() {
    super("BAD_REQUEST", "This plan is free. Choose a paid plan to subscribe.", "plan_not_offered");
    this.name = "PlanNotOfferedError";
  }
}
