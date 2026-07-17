import { describe, expect, test } from "bun:test";
import { createAdaptiveHibernationPolicy } from "../src/adaptiveHibernation";

describe("adaptive hibernation policy", () => {
  test("backs off after repeated short-residence wake churn", () => {
    const policy = createAdaptiveHibernationPolicy({
      adjustmentStepMs: 5_000,
      initialIdleMs: 10_000,
      maximumIdleMs: 30_000,
      minimumIdleMs: 5_000,
      minimumResidenceMs: 20_000,
      observationsPerAdjustment: 2,
    });

    expect(
      policy.observe({ residenceMs: 1_000, spawnMs: 10, wakeMs: 3 }).action,
    ).toBe("hold");
    expect(
      policy.observe({ residenceMs: 2_000, spawnMs: 10, wakeMs: 3 }),
    ).toMatchObject({
      action: "increase",
      effectiveIdleMs: 15_000,
      reason: "wake-churn",
    });
    expect(policy.metrics()).toMatchObject({ adjustments: 1, increases: 1 });
  });

  test("hibernates sooner after repeated valuable residence", () => {
    const policy = createAdaptiveHibernationPolicy({
      adjustmentStepMs: 5_000,
      initialIdleMs: 15_000,
      maximumIdleMs: 30_000,
      minimumIdleMs: 5_000,
      minimumResidenceMs: 10_000,
      observationsPerAdjustment: 2,
    });

    policy.observe({ residenceMs: 30_000, spawnMs: 20, wakeMs: 5 });
    expect(
      policy.observe({ residenceMs: 40_000, spawnMs: 20, wakeMs: 5 }),
    ).toMatchObject({
      action: "decrease",
      effectiveIdleMs: 10_000,
      reason: "checkpoint-residence-valuable",
    });
  });

  test("treats a wake slower than a fresh spawn as negative evidence", () => {
    const policy = createAdaptiveHibernationPolicy({
      initialIdleMs: 10_000,
      observationsPerAdjustment: 1,
    });

    expect(
      policy.observe({ residenceMs: 60_000, spawnMs: 10, wakeMs: 20 }),
    ).toMatchObject({
      action: "increase",
      reason: "wake-slower-than-spawn",
    });
  });

  test("rejects unsafe bounds", () => {
    expect(() =>
      createAdaptiveHibernationPolicy({
        initialIdleMs: 10_000,
        minimumIdleMs: 20_000,
      }),
    ).toThrow("initialIdleMs must be between");
  });
});
