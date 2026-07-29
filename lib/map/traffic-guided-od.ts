import type {
  FeatureCollection,
  FlowProperties,
  MobilityFlowProperties,
  Position
} from "@/lib/dashboard/types";

type GraphEdge = {
  to: string;
  distanceMeters: number;
  jamFactor: number;
};

type GraphNode = {
  coordinate: Position;
  edges: GraphEdge[];
  component: number;
};

type QueueItem = {
  key: string;
  priority: number;
};

const JAM_PREFERENCE = 0.35;
const MINIMUM_COST_FACTOR = 1 - JAM_PREFERENCE;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function coordinateKey([longitude, latitude]: Position) {
  return `${longitude.toFixed(5)},${latitude.toFixed(5)}`;
}

function distanceMeters(from: Position, to: Position) {
  const meanLatitudeRadians = (from[1] + to[1]) * Math.PI / 360;
  const longitudeMeters = (to[0] - from[0]) * 111_320 * Math.cos(meanLatitudeRadians);
  const latitudeMeters = (to[1] - from[1]) * 110_540;
  return Math.hypot(longitudeMeters, latitudeMeters);
}

function pointSegmentDistanceMeters(point: Position, start: Position, end: Position) {
  const meanLatitudeRadians = (start[1] + end[1]) * Math.PI / 360;
  const longitudeScale = 111_320 * Math.cos(meanLatitudeRadians);
  const latitudeScale = 110_540;
  const endX = (end[0] - start[0]) * longitudeScale;
  const endY = (end[1] - start[1]) * latitudeScale;
  const pointX = (point[0] - start[0]) * longitudeScale;
  const pointY = (point[1] - start[1]) * latitudeScale;
  const lengthSquared = endX * endX + endY * endY;
  if (lengthSquared === 0) return Math.hypot(pointX, pointY);
  const progress = clamp((pointX * endX + pointY * endY) / lengthSquared, 0, 1);
  return Math.hypot(pointX - endX * progress, pointY - endY * progress);
}

function simplifyPath(coordinates: Position[], toleranceMeters = 4) {
  if (coordinates.length <= 2) return coordinates;
  const retained = new Uint8Array(coordinates.length);
  retained[0] = 1;
  retained[coordinates.length - 1] = 1;
  const pending: Array<[number, number]> = [[0, coordinates.length - 1]];
  while (pending.length) {
    const [startIndex, endIndex] = pending.pop()!;
    let farthestIndex = -1;
    let farthestDistance = toleranceMeters;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = pointSegmentDistanceMeters(
        coordinates[index]!,
        coordinates[startIndex]!,
        coordinates[endIndex]!
      );
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    }
    if (farthestIndex < 0) continue;
    retained[farthestIndex] = 1;
    pending.push([startIndex, farthestIndex], [farthestIndex, endIndex]);
  }
  return coordinates.filter((_coordinate, index) => retained[index] === 1);
}

function lineStrings(
  feature: FeatureCollection<FlowProperties>["features"][number]
): Position[][] {
  if (feature.geometry.type === "LineString") return [feature.geometry.coordinates];
  if (feature.geometry.type === "MultiLineString") return feature.geometry.coordinates;
  return [];
}

function addEdge(nodes: Map<string, GraphNode>, from: Position, to: Position, jamFactor: number) {
  const fromKey = coordinateKey(from);
  const toKey = coordinateKey(to);
  if (fromKey === toKey) return;
  const length = distanceMeters(from, to);
  if (!Number.isFinite(length) || length <= 0) return;
  const fromNode = nodes.get(fromKey) ?? { coordinate: from, edges: [], component: -1 };
  const toNode = nodes.get(toKey) ?? { coordinate: to, edges: [], component: -1 };
  fromNode.edges.push({ to: toKey, distanceMeters: length, jamFactor });
  toNode.edges.push({ to: fromKey, distanceMeters: length, jamFactor });
  nodes.set(fromKey, fromNode);
  nodes.set(toKey, toNode);
}

function buildTrafficGraph(traffic: FeatureCollection<FlowProperties>) {
  const nodes = new Map<string, GraphNode>();
  for (const feature of traffic.features) {
    if (feature.properties.roadClosure) continue;
    const jamFactor = clamp(Number(feature.properties.jamFactor) || 0, 0, 10);
    for (const coordinates of lineStrings(feature)) {
      for (let index = 1; index < coordinates.length; index += 1) {
        addEdge(nodes, coordinates[index - 1]!, coordinates[index]!, jamFactor);
      }
    }
  }
  let component = 0;
  for (const [startKey, startNode] of nodes) {
    if (startNode.component >= 0) continue;
    const pending = [startKey];
    startNode.component = component;
    while (pending.length) {
      const key = pending.pop()!;
      const node = nodes.get(key)!;
      for (const edge of node.edges) {
        const neighbor = nodes.get(edge.to)!;
        if (neighbor.component >= 0) continue;
        neighbor.component = component;
        pending.push(edge.to);
      }
    }
    component += 1;
  }
  return nodes;
}

function nearestConnectedPair(
  nodes: Map<string, GraphNode>,
  origin: Position,
  destination: Position
) {
  const candidates = new Map<number, {
    originKey: string;
    originDistance: number;
    destinationKey: string;
    destinationDistance: number;
  }>();
  for (const [key, node] of nodes) {
    const originDistance = distanceMeters(origin, node.coordinate);
    const destinationDistance = distanceMeters(destination, node.coordinate);
    const candidate = candidates.get(node.component);
    if (!candidate) {
      candidates.set(node.component, {
        originKey: key,
        originDistance,
        destinationKey: key,
        destinationDistance
      });
      continue;
    }
    if (originDistance < candidate.originDistance) {
      candidate.originKey = key;
      candidate.originDistance = originDistance;
    }
    if (destinationDistance < candidate.destinationDistance) {
      candidate.destinationKey = key;
      candidate.destinationDistance = destinationDistance;
    }
  }
  return [...candidates.values()]
    .filter((candidate) => candidate.originKey !== candidate.destinationKey)
    .sort((left, right) =>
      left.originDistance + left.destinationDistance -
      (right.originDistance + right.destinationDistance)
    )[0] ?? null;
}

class MinimumQueue {
  private items: QueueItem[] = [];

  push(item: QueueItem) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent]!.priority <= item.priority) break;
      this.items[index] = this.items[parent]!;
      index = parent;
    }
    this.items[index] = item;
  }

  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last || this.items.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.items.length) break;
      const child = right < this.items.length &&
        this.items[right]!.priority < this.items[left]!.priority
        ? right
        : left;
      if (this.items[child]!.priority >= last.priority) break;
      this.items[index] = this.items[child]!;
      index = child;
    }
    this.items[index] = last;
    return first;
  }

  get length() {
    return this.items.length;
  }
}

function guidedPath(
  nodes: Map<string, GraphNode>,
  origin: Position,
  destination: Position
) {
  const pair = nearestConnectedPair(nodes, origin, destination);
  if (!pair) return null;
  const start = pair.originKey;
  const goal = pair.destinationKey;

  const queue = new MinimumQueue();
  const costs = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, string>();
  queue.push({ key: start, priority: 0 });

  while (queue.length) {
    const current = queue.pop()!;
    if (current.key === goal) break;
    const currentCost = costs.get(current.key);
    const node = nodes.get(current.key);
    if (currentCost == null || !node) continue;
    for (const edge of node.edges) {
      const jamRatio = clamp(edge.jamFactor / 10, 0, 1);
      const edgeCost = edge.distanceMeters * (1 - JAM_PREFERENCE * jamRatio);
      const nextCost = currentCost + edgeCost;
      if (nextCost >= (costs.get(edge.to) ?? Infinity)) continue;
      costs.set(edge.to, nextCost);
      previous.set(edge.to, current.key);
      const heuristic = distanceMeters(nodes.get(edge.to)!.coordinate, nodes.get(goal)!.coordinate) *
        MINIMUM_COST_FACTOR;
      queue.push({ key: edge.to, priority: nextCost + heuristic });
    }
  }

  if (!previous.has(goal)) return null;
  const keys = [goal];
  while (keys[0] !== start) {
    const parent = previous.get(keys[0]!);
    if (!parent) return null;
    keys.unshift(parent);
  }
  let totalLengthMeters = 0;
  let jamLength = 0;
  for (let index = 1; index < keys.length; index += 1) {
    const from = nodes.get(keys[index - 1]!)!;
    const edge = from.edges.find((candidate) => candidate.to === keys[index]);
    if (!edge) continue;
    totalLengthMeters += edge.distanceMeters;
    jamLength += edge.jamFactor * edge.distanceMeters;
  }
  return {
    coordinates: simplifyPath(keys.map((key) => nodes.get(key)!.coordinate)),
    weightedJamFactor: totalLengthMeters > 0 ? jamLength / totalLengthMeters : null
  };
}

export function guideOdFlowsByTraffic(
  flows: FeatureCollection<MobilityFlowProperties>,
  traffic: FeatureCollection<FlowProperties>
): FeatureCollection<MobilityFlowProperties> {
  if (!traffic.features.length) return flows;
  const graph = buildTrafficGraph(traffic);
  if (!graph.size) return flows;
  return {
    type: "FeatureCollection",
    features: flows.features.map((flow) => {
      if (flow.geometry.type !== "LineString") return flow;
      const origin = flow.geometry.coordinates[0];
      const destination = flow.geometry.coordinates.at(-1);
      if (!origin || !destination) return flow;
      const path = guidedPath(graph, origin, destination);
      if (!path || path.coordinates.length < 2) return flow;
      const coordinates = [origin, ...path.coordinates, destination].filter((coordinate, index, items) =>
        index === 0 || coordinateKey(coordinate) !== coordinateKey(items[index - 1]!)
      );
      return {
        ...flow,
        // Road routing may snap to nearby network nodes, but the v2
        // directional contract requires the rendered line to retain the
        // authoritative origin and destination coordinates as its endpoints.
        geometry: { type: "LineString" as const, coordinates },
        properties: {
          ...flow.properties,
          pathSemantics: "traffic_network_guided" as const,
          routeWeightedJamFactor: path.weightedJamFactor
        }
      };
    })
  };
}
