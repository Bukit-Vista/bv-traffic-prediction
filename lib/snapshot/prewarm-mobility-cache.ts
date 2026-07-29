import {
  readCatchmentCenters,
  readCatchmentFlows,
  readCatchmentOverview,
  readCatchmentZones,
  type CatchmentServingMode
} from "@/lib/api/internal-catchment-preview";

export async function prewarmMobilityCache(servingMode: CatchmentServingMode = "internal") {
  // Warm zones first because overview reuses them. The remaining resources can
  // then load concurrently without duplicating the largest geometry query.
  const zones = await readCatchmentZones(undefined, servingMode);
  const [overview, flows, centers] = await Promise.all([
    readCatchmentOverview(undefined, servingMode),
    readCatchmentFlows({ minScore: 0, limit: 420 }, undefined, servingMode),
    readCatchmentCenters(undefined, undefined, servingMode)
  ]);
  const modelRunIds = new Set([
    zones.meta.modelRunId,
    overview.meta.modelRunId,
    flows.meta.modelRunId,
    centers.meta.modelRunId
  ]);
  if (modelRunIds.size !== 1) {
    throw new Error("Mobility cache resources did not resolve to one model run.");
  }
  return {
    modelRunId: zones.meta.modelRunId,
    servingMode,
    zones: zones.collection.features.length,
    flows: flows.flows.length,
    centers: centers.summaries.length
  };
}
