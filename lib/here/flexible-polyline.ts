const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DECODING = new Map([...ALPHABET].map((character, index) => [character, index]));

export type DecodedFlexiblePolyline = {
  precision: number;
  thirdDimension: number;
  thirdDimensionPrecision: number;
  coordinates: Array<[number, number] | [number, number, number]>;
};

function decodeUnsigned(encoded: string, cursor: { value: number }) {
  let result = 0;
  let shift = 0;
  while (cursor.value < encoded.length) {
    const character = encoded[cursor.value++];
    const value = character == null ? undefined : DECODING.get(character);
    if (value == null) throw new Error("Flexible polyline contains an unsupported character");
    result |= (value & 0x1f) << shift;
    if ((value & 0x20) === 0) return result;
    shift += 5;
    if (shift > 53) throw new Error("Flexible polyline value exceeds safe integer precision");
  }
  throw new Error("Flexible polyline ended mid-value");
}

function toSigned(value: number) {
  return value & 1 ? -(value + 1) / 2 : value / 2;
}

export function decodeFlexiblePolyline(encoded: string): DecodedFlexiblePolyline {
  const cursor = { value: 0 };
  const version = decodeUnsigned(encoded, cursor);
  if (version !== 1) throw new Error(`Unsupported flexible polyline version: ${version}`);

  const header = decodeUnsigned(encoded, cursor);
  const precision = header & 15;
  const thirdDimension = (header >> 4) & 7;
  const thirdDimensionPrecision = (header >> 7) & 15;
  const factor = 10 ** precision;
  const thirdFactor = 10 ** thirdDimensionPrecision;
  const coordinates: DecodedFlexiblePolyline["coordinates"] = [];
  let latitude = 0;
  let longitude = 0;
  let third = 0;

  while (cursor.value < encoded.length) {
    latitude += toSigned(decodeUnsigned(encoded, cursor));
    longitude += toSigned(decodeUnsigned(encoded, cursor));
    if (thirdDimension !== 0) {
      third += toSigned(decodeUnsigned(encoded, cursor));
      coordinates.push([longitude / factor, latitude / factor, third / thirdFactor]);
    } else {
      coordinates.push([longitude / factor, latitude / factor]);
    }
  }

  return { precision, thirdDimension, thirdDimensionPrecision, coordinates };
}

export function combineFlexiblePolylineSections(encodedSections: string[]) {
  const coordinates: Array<[number, number] | [number, number, number]> = [];
  for (const section of encodedSections) {
    const decoded = decodeFlexiblePolyline(section).coordinates;
    const first = decoded[0];
    const previous = coordinates.at(-1);
    const startsAtPrevious = first && previous && first[0] === previous[0] && first[1] === previous[1];
    coordinates.push(...(startsAtPrevious ? decoded.slice(1) : decoded));
  }
  return { type: "LineString" as const, coordinates };
}

