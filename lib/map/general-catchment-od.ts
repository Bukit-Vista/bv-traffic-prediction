export const GENERAL_OD_EXCLUDED_CATCHMENT_KEYS: ReadonlySet<string> =
  new Set();
export const GENERAL_OD_MINIMUM_PREDICTED_SHARE = 0.01;

export type GeneralOdDirection = "both" | "outbound" | "inbound";

type GeneralOdRecord = {
  originCatchmentKey: string;
  destinationCatchmentKey: string;
  predictedShare: number;
  confidence: number;
};

export function isGeneralOdPair(flow: GeneralOdRecord) {
  return (
    !GENERAL_OD_EXCLUDED_CATCHMENT_KEYS.has(flow.originCatchmentKey) &&
    !GENERAL_OD_EXCLUDED_CATCHMENT_KEYS.has(flow.destinationCatchmentKey)
  );
}

export function selectGeneralOdFlows<T extends GeneralOdRecord>(
  flows: T[],
  options: {
    focusCatchmentKey: string;
    direction: GeneralOdDirection;
    minimumPredictedShare: number;
    minimumConfidence: number;
  }
) {
  return flows.filter((flow) => {
    if (!isGeneralOdPair(flow)) return false;
    if (
      options.focusCatchmentKey &&
      (
        options.direction === "outbound"
          ? flow.originCatchmentKey !== options.focusCatchmentKey
          : options.direction === "inbound"
            ? flow.destinationCatchmentKey !== options.focusCatchmentKey
            : (
              flow.originCatchmentKey !== options.focusCatchmentKey &&
              flow.destinationCatchmentKey !== options.focusCatchmentKey
            )
      )
    ) {
      return false;
    }
    return (
      flow.predictedShare > options.minimumPredictedShare &&
      flow.confidence >= options.minimumConfidence
    );
  });
}
