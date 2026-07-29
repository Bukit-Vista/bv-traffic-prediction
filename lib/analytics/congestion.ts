export function calculateCongestionScore(input: {
  durationSeconds: number;
  trafficDurationSeconds: number;
}) {
  if (input.durationSeconds <= 0) {
    return null;
  }

  return input.trafficDurationSeconds / input.durationSeconds;
}

export function formatCongestionScore(score: number | null | undefined) {
  if (score == null || Number.isNaN(score)) {
    return "Missing";
  }

  return `${score.toFixed(2)}x`;
}

export function congestionBand(score: number | null | undefined) {
  if (score == null || Number.isNaN(score)) {
    return "empty";
  }

  if (score <= 1.15) {
    return "green";
  }

  if (score <= 1.35) {
    return "yellow";
  }

  return "red";
}
