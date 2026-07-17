export type AdaptiveHibernationPolicyOptions = {
  adjustmentStepMs?: number;
  initialIdleMs: number;
  maximumIdleMs?: number;
  maximumWakeToSpawnRatio?: number;
  minimumIdleMs?: number;
  minimumResidenceMs?: number;
  observationsPerAdjustment?: number;
};

export type AdaptiveHibernationObservation = {
  residenceMs: number;
  spawnMs?: number;
  wakeMs: number;
};

export type AdaptiveHibernationAdjustmentReason =
  | "checkpoint-residence-valuable"
  | "insufficient-evidence"
  | "wake-churn"
  | "wake-slower-than-spawn";

export type AdaptiveHibernationDecision = {
  action: "decrease" | "hold" | "increase";
  effectiveIdleMs: number;
  evidenceScore: number;
  observations: number;
  previousIdleMs: number;
  reason: AdaptiveHibernationAdjustmentReason;
};

export type AdaptiveHibernationMetrics = {
  adjustments: number;
  decreases: number;
  effectiveIdleMs: number;
  evidenceScore: number;
  increases: number;
  lastReason: AdaptiveHibernationAdjustmentReason;
  observations: number;
};

export type AdaptiveHibernationPolicy = {
  effectiveIdleMs: () => number;
  metrics: () => AdaptiveHibernationMetrics;
  observe: (
    observation: AdaptiveHibernationObservation,
  ) => AdaptiveHibernationDecision;
};

const positiveInteger = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer`);

  return value;
};

const nonNegativeInteger = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative integer`);

  return value;
};

export const createAdaptiveHibernationPolicy = (
  options: AdaptiveHibernationPolicyOptions,
): AdaptiveHibernationPolicy => {
  const initialIdleMs = positiveInteger(options.initialIdleMs, "initialIdleMs");
  const minimumIdleMs = positiveInteger(
    options.minimumIdleMs ?? Math.max(1_000, Math.floor(initialIdleMs / 4)),
    "minimumIdleMs",
  );
  const maximumIdleMs = positiveInteger(
    options.maximumIdleMs ?? Math.max(initialIdleMs * 8, minimumIdleMs),
    "maximumIdleMs",
  );
  const adjustmentStepMs = positiveInteger(
    options.adjustmentStepMs ?? Math.max(1_000, Math.floor(initialIdleMs / 2)),
    "adjustmentStepMs",
  );
  const observationsPerAdjustment = positiveInteger(
    options.observationsPerAdjustment ?? 3,
    "observationsPerAdjustment",
  );
  const minimumResidenceMs = nonNegativeInteger(
    options.minimumResidenceMs ?? initialIdleMs,
    "minimumResidenceMs",
  );
  const maximumWakeToSpawnRatio = options.maximumWakeToSpawnRatio ?? 1.25;
  if (!Number.isFinite(maximumWakeToSpawnRatio) || maximumWakeToSpawnRatio <= 0)
    throw new Error("maximumWakeToSpawnRatio must be positive");
  if (minimumIdleMs > initialIdleMs || initialIdleMs > maximumIdleMs)
    throw new Error(
      "initialIdleMs must be between minimumIdleMs and maximumIdleMs",
    );

  let effectiveIdleMs = initialIdleMs;
  let evidenceScore = 0;
  let observations = 0;
  let adjustments = 0;
  let increases = 0;
  let decreases = 0;
  let lastReason: AdaptiveHibernationAdjustmentReason = "insufficient-evidence";

  const classify = (
    observation: AdaptiveHibernationObservation,
  ): { reason: AdaptiveHibernationAdjustmentReason; score: -1 | 1 } => {
    nonNegativeInteger(observation.residenceMs, "residenceMs");
    nonNegativeInteger(observation.wakeMs, "wakeMs");
    if (observation.spawnMs !== undefined)
      nonNegativeInteger(observation.spawnMs, "spawnMs");
    if (observation.residenceMs < minimumResidenceMs)
      return { reason: "wake-churn", score: 1 };
    if (
      observation.spawnMs !== undefined &&
      observation.spawnMs > 0 &&
      observation.wakeMs > observation.spawnMs * maximumWakeToSpawnRatio
    )
      return { reason: "wake-slower-than-spawn", score: 1 };

    return { reason: "checkpoint-residence-valuable", score: -1 };
  };

  return {
    effectiveIdleMs: () => effectiveIdleMs,
    metrics: () => ({
      adjustments,
      decreases,
      effectiveIdleMs,
      evidenceScore,
      increases,
      lastReason,
      observations,
    }),
    observe: (observation) => {
      const evidence = classify(observation);
      evidenceScore += evidence.score;
      observations += 1;
      const previousIdleMs = effectiveIdleMs;
      let action: AdaptiveHibernationDecision["action"] = "hold";
      let reason: AdaptiveHibernationAdjustmentReason = "insufficient-evidence";
      if (observations >= observationsPerAdjustment) {
        reason = evidence.reason;
        if (evidenceScore > 0) {
          effectiveIdleMs = Math.min(
            maximumIdleMs,
            effectiveIdleMs + adjustmentStepMs,
          );
          action = effectiveIdleMs > previousIdleMs ? "increase" : "hold";
        } else if (evidenceScore < 0) {
          effectiveIdleMs = Math.max(
            minimumIdleMs,
            effectiveIdleMs - adjustmentStepMs,
          );
          action = effectiveIdleMs < previousIdleMs ? "decrease" : "hold";
        }
        if (action !== "hold") {
          adjustments += 1;
          if (action === "increase") increases += 1;
          else decreases += 1;
        }
        evidenceScore = 0;
        observations = 0;
      }
      lastReason = reason;

      return {
        action,
        effectiveIdleMs,
        evidenceScore,
        observations,
        previousIdleMs,
        reason,
      };
    },
  };
};
