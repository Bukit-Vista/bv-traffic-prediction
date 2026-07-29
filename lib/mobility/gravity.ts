export type GravityConfig = {
  version: string;
  alpha: number;
  gamma: number;
  betaPerMinute: number;
  minimumTrafficConfidence: number;
  maximumDestinationsPerOrigin: number;
  presenceWeights: { inbound: number; attraction: number; localActivity: number };
  confidenceWeights: { inputCoverage: number; traffic: number; poiCompleteness: number; travelTimeFreshness: number };
};

export type GravityZone = {
  id: number;
  populationPotential: number;
  departureFactor: number;
  attractionScore: number;
  arrivalFactor: number;
  trafficActivityScore: number;
  incidentPenalty: number;
  trafficConfidence: number;
  inputCoverage: number;
  poiCompleteness: number;
};

export type GravityCandidate = {
  originZoneId: number;
  destinationZoneId: number;
  travelTimeMinutes: number;
  distanceMeters?: number;
  travelTimeFreshness: number;
};

export type GravityOdPrediction = {
  originZoneId: number;
  destinationZoneId: number;
  rawFlowWeight: number;
  mobilityScore: number;
  predictedShare: number;
  travelTimeSeconds: number;
  distanceMeters: number | null;
  confidence: number;
};

export type GravityZonePrediction = {
  zoneId: number;
  presenceScore: number;
  inboundScore: number;
  outboundScore: number;
  hotspotRank: number;
  confidence: number;
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalize(values: Map<number, number>) {
  const all = [...values.values()];
  const max = Math.max(0, ...all);
  const result = new Map<number, number>();
  for (const [key, value] of values) result.set(key, max === 0 ? 0 : (value / max) * 100);
  return result;
}

function rounded(value: number, digits = 5) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function confidenceFor(
  origin: GravityZone,
  destination: GravityZone,
  travelTimeFreshness: number,
  config: GravityConfig
) {
  const traffic = (clamp(origin.trafficConfidence) + clamp(destination.trafficConfidence)) / 2;
  const coverage = (clamp(origin.inputCoverage) + clamp(destination.inputCoverage)) / 2;
  const poi = clamp(destination.poiCompleteness);
  const weights = config.confidenceWeights;
  return clamp(
    coverage * weights.inputCoverage + traffic * weights.traffic +
      poi * weights.poiCompleteness + clamp(travelTimeFreshness) * weights.travelTimeFreshness
  );
}

export function runGravityModel(
  zones: GravityZone[],
  candidates: GravityCandidate[],
  config: GravityConfig
) {
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  const candidateGroups = new Map<number, GravityCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.originZoneId === candidate.destinationZoneId) continue;
    if (!zoneById.has(candidate.originZoneId) || !zoneById.has(candidate.destinationZoneId)) continue;
    const group = candidateGroups.get(candidate.originZoneId) ?? [];
    group.push(candidate);
    candidateGroups.set(candidate.originZoneId, group);
  }

  const retained = [...candidateGroups.entries()].flatMap(([, group]) =>
    [...group]
      .sort((a, b) => {
        const aDestination = zoneById.get(a.destinationZoneId)!;
        const bDestination = zoneById.get(b.destinationZoneId)!;
        const aRank = aDestination.attractionScore * Math.exp(-config.betaPerMinute * a.travelTimeMinutes);
        const bRank = bDestination.attractionScore * Math.exp(-config.betaPerMinute * b.travelTimeMinutes);
        return bRank - aRank || a.destinationZoneId - b.destinationZoneId;
      })
      .slice(0, config.maximumDestinationsPerOrigin)
  );

  const raw = retained.map((candidate) => {
    const origin = zoneById.get(candidate.originZoneId)!;
    const destination = zoneById.get(candidate.destinationZoneId)!;
    const originPotential = Math.max(0, origin.populationPotential * origin.departureFactor);
    const destinationPull = Math.max(0, destination.attractionScore * destination.arrivalFactor);
    const travelImpedance = Math.exp(-config.betaPerMinute * Math.max(0, candidate.travelTimeMinutes));
    const trafficConfidence = Math.min(origin.trafficConfidence, destination.trafficConfidence);
    const trafficActivity = (origin.trafficActivityScore + destination.trafficActivityScore) / 2;
    const incidentPenalty = clamp((origin.incidentPenalty + destination.incidentPenalty) / 2);
    const confidenceDamping = trafficConfidence < config.minimumTrafficConfidence ? .65 : 1;
    const trafficFactor = clamp((.7 + .45 * clamp(trafficActivity) - .35 * incidentPenalty) * confidenceDamping, .2, 1.2);
    const rawFlowWeight =
      originPotential ** config.alpha * destinationPull ** config.gamma * travelImpedance * trafficFactor;
    return { candidate, rawFlowWeight, confidence: confidenceFor(origin, destination, candidate.travelTimeFreshness, config) };
  });

  const maxRaw = Math.max(0, ...raw.map((item) => item.rawFlowWeight));
  const totalByOrigin = new Map<number, number>();
  for (const item of raw) totalByOrigin.set(item.candidate.originZoneId, (totalByOrigin.get(item.candidate.originZoneId) ?? 0) + item.rawFlowWeight);

  const odPredictions: GravityOdPrediction[] = raw.map((item) => ({
    originZoneId: item.candidate.originZoneId,
    destinationZoneId: item.candidate.destinationZoneId,
    rawFlowWeight: rounded(item.rawFlowWeight, 8),
    mobilityScore: rounded(maxRaw === 0 ? 0 : (item.rawFlowWeight / maxRaw) * 100, 2),
    predictedShare: rounded(item.rawFlowWeight / Math.max(Number.EPSILON, totalByOrigin.get(item.candidate.originZoneId) ?? 0), 9),
    travelTimeSeconds: Math.round(item.candidate.travelTimeMinutes * 60),
    distanceMeters: item.candidate.distanceMeters == null ? null : Math.round(item.candidate.distanceMeters),
    confidence: rounded(item.confidence, 5)
  }));

  const incoming = new Map<number, number>();
  const outgoing = new Map<number, number>();
  for (const prediction of odPredictions) {
    incoming.set(prediction.destinationZoneId, (incoming.get(prediction.destinationZoneId) ?? 0) + prediction.rawFlowWeight);
    outgoing.set(prediction.originZoneId, (outgoing.get(prediction.originZoneId) ?? 0) + prediction.rawFlowWeight);
  }
  const inbound = normalize(incoming);
  const outbound = normalize(outgoing);
  const attraction = normalize(new Map(zones.map((zone) => [zone.id, zone.attractionScore])));
  const localActivity = normalize(new Map(zones.map((zone) => [zone.id, zone.trafficActivityScore])));

  const baseZonePredictions = zones.map((zone) => {
    const zoneOd = odPredictions.filter((prediction) => prediction.originZoneId === zone.id || prediction.destinationZoneId === zone.id);
    const odConfidence = zoneOd.length ? zoneOd.reduce((sum, item) => sum + item.confidence, 0) / zoneOd.length : zone.inputCoverage;
    const presence =
      (inbound.get(zone.id) ?? 0) * config.presenceWeights.inbound +
      (attraction.get(zone.id) ?? 0) * config.presenceWeights.attraction +
      (localActivity.get(zone.id) ?? 0) * config.presenceWeights.localActivity;
    return {
      zoneId: zone.id,
      presenceScore: rounded(clamp(presence, 0, 100), 2),
      inboundScore: rounded(inbound.get(zone.id) ?? 0, 2),
      outboundScore: rounded(outbound.get(zone.id) ?? 0, 2),
      confidence: rounded(clamp(odConfidence), 5)
    };
  });
  const ranks = new Map(
    [...baseZonePredictions]
      .sort((a, b) => b.presenceScore - a.presenceScore || a.zoneId - b.zoneId)
      .map((prediction, index) => [prediction.zoneId, index + 1])
  );
  const zonePredictions: GravityZonePrediction[] = baseZonePredictions.map((prediction) => ({
    ...prediction,
    hotspotRank: ranks.get(prediction.zoneId) ?? zones.length
  }));

  return {
    modelVersion: config.version,
    odPredictions,
    zonePredictions,
    retainedCandidateCount: retained.length,
    suppressedCandidateCount: Math.max(0, candidates.length - retained.length)
  };
}

