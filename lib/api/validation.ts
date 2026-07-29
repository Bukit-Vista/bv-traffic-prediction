import { z } from "zod";
import { BALI_QUERY_BOUNDS, isBaliViewport } from "@/lib/api/spatial";
import { clampBaliQueryBbox } from "@/lib/map/viewport";

const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const optionalDateTime = z.preprocess(
  (value) => (value === "" || value == null ? undefined : value),
  isoDateTime.optional()
);

export const bboxSchema = z
  .string()
  .transform((value) => value.split(",").map(Number))
  .refine(
    (value) => value.length === 4 && value.every(Number.isFinite),
    "bbox must be west,south,east,north"
  )
  .refine(
    ([west, south, east, north]) =>
      west! >= -180 && east! <= 180 && south! >= -90 && north! <= 90 &&
      west! < east! && south! < north!,
    "bbox coordinates are outside valid bounds or reversed"
  )
  .refine((value) => isBaliViewport(value as [number, number, number, number]),
    "bbox must stay within the supported Bali viewport and size")
  .transform((value) => value as [number, number, number, number]);

const cameraBboxSchema = z
  .string()
  .transform((value) => value.split(",").map(Number))
  .refine(
    (value) => value.length === 4 && value.every(Number.isFinite),
    "bbox must be west,south,east,north"
  )
  .refine(
    ([west, south, east, north]) =>
      west! >= -180 && east! <= 180 && south! >= -90 && north! <= 90 &&
      west! < east! && south! < north!,
    "bbox coordinates are outside valid bounds or reversed"
  )
  .refine(([west, south, east, north]) => {
    const [minimumWest, minimumSouth, maximumEast, maximumNorth] = BALI_QUERY_BOUNDS;
    return east! >= minimumWest && west! <= maximumEast &&
      north! >= minimumSouth && south! <= maximumNorth;
  }, "bbox must overlap the supported Bali viewport")
  .transform((value) => clampBaliQueryBbox(value as [number, number, number, number]));

export const mapQuerySchema = z.object({
  bbox: bboxSchema.default("114.34,-8.90,115.78,-8.03"),
  at: z.union([z.literal("latest"), isoDateTime]).default("latest"),
  minConfidence: z.coerce.number().min(0).max(1).default(0),
  functionalClass: z.coerce.number().int().min(1).max(5).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(2500)
});

export const mobilityZonesQuerySchema = mapQuerySchema.pick({ bbox: true, at: true, limit: true }).extend({
  metric: z.enum(["presence", "inbound", "outbound", "attraction"]).default("presence")
});

export const mobilityFlowsQuerySchema = mapQuerySchema.pick({ bbox: true, at: true, limit: true }).extend({
  minScore: z.coerce.number().min(0).max(100).default(45),
  originZoneId: z.coerce.number().int().positive().optional(),
  destinationZoneId: z.coerce.number().int().positive().optional()
});

export const centersQuerySchema = mapQuerySchema.pick({ bbox: true, at: true, limit: true }).extend({
  category: z.string().trim().min(1).max(80).optional()
});

const placesCategorySchema = z.enum([
  "dining", "accommodation", "attraction", "culture", "beach",
  "shopping", "nightlife", "recreation", "transport"
]);

export const displayGridQuerySchema = z.object({
  bbox: cameraBboxSchema,
  metric: z.enum(["attraction", "placeDensity"]).default("attraction"),
  category: z.enum([
    "all", "dining", "accommodation", "attraction", "culture", "beach",
    "shopping", "nightlife", "recreation", "transport"
  ]).default("all"),
  limit: z.coerce.number().int().min(1).max(5000).default(2000)
});

export const placesQuerySchema = z.object({
  mode: z.enum(["aggregate", "cluster", "point"]).default("aggregate"),
  bbox: z.preprocess(
    (value) => value === "" || value == null ? undefined : value,
    cameraBboxSchema.optional()
  ),
  zoom: z.preprocess(
    (value) => value === "" || value == null ? undefined : value,
    z.coerce.number().int().min(0).max(22).optional()
  ),
  category: placesCategorySchema.optional(),
  eligibleOnly: z.preprocess(
    (value) => value == null || value === "" ? false : value,
    z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
  ),
  limit: z.coerce.number().int().min(1).max(2000).default(2000),
  cursor: z.string().trim().min(1).max(500).optional(),
  at: z.union([z.literal("latest"), isoDateTime]).default("latest")
}).superRefine((value, context) => {
  if (value.mode !== "aggregate" && !value.bbox) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["bbox"], message: "bbox is required for cluster and point mode" });
  }
  if (value.mode !== "aggregate" && value.zoom == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["zoom"], message: "zoom is required for cluster and point mode" });
  }
  if (value.cursor && value.mode !== "point") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cursor"], message: "cursor is only supported in point mode" });
  }
});

export const mobilityModelRunsQuerySchema = z
  .object({
    from: optionalDateTime,
    to: optionalDateTime,
    status: z.enum(["running", "success", "partial", "failed"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100)
  })
  .superRefine((value, context) => {
    if (value.from && value.to && new Date(value.from).getTime() >= new Date(value.to).getTime()) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "from must be before to" });
    }
  });

export const rangeQuerySchema = z
  .object({
    from: optionalDateTime,
    to: optionalDateTime,
    bucket: z.enum(["30m", "1h", "1d"]).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(500)
  })
  .superRefine((value, context) => {
    if (value.from && value.to) {
      const from = new Date(value.from).getTime();
      const to = new Date(value.to).getTime();
      if (from >= to) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "from must be before to" });
      }
      if (to - from > 93 * 86_400_000) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "date range cannot exceed 93 days" });
      }
    }
  });

export const mvpWindowQuerySchema = z.object({
  hours: z.coerce.number().int().positive().max(168).default(12),
  from: optionalDateTime,
  to: optionalDateTime,
  limit: z.coerce.number().int().min(1).max(5000).default(500)
}).superRefine((value, context) => {
  if (Boolean(value.from) !== Boolean(value.to)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "from and to must be provided together" });
  }
});

export type BoundedUtcRange = { from: string; to: string; limit: number; bucket?: "30m" | "1h" | "1d" };

/** Resolve partial or omitted ranges to a bounded seven-day UTC window. */
export function resolveBoundedUtcRange(
  input: { from?: string; to?: string; limit: number; bucket?: "30m" | "1h" | "1d" },
  now = Date.now(),
  defaultDays = 7,
  maximumDays = 93
): BoundedUtcRange {
  const windowMs = defaultDays * 86_400_000;
  const toMs = input.to ? new Date(input.to).getTime() : input.from ? new Date(input.from).getTime() + windowMs : now;
  const fromMs = input.from ? new Date(input.from).getTime() : toMs - windowMs;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new RangeError("from must be before to");
  }
  if (toMs - fromMs > maximumDays * 86_400_000) {
    throw new RangeError(`date range cannot exceed ${maximumDays} days`);
  }
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    limit: input.limit,
    ...(input.bucket ? { bucket: input.bucket } : {})
  };
}

export const idSchema = z.coerce.number().int().positive();

export const routeGeometryQuerySchema = z.object({
  at: z.union([z.literal("latest"), isoDateTime]).default("latest")
});

export const routeAtQuerySchema = routeGeometryQuerySchema;

export function searchParamsObject(url: URL) {
  return Object.fromEntries(url.searchParams.entries());
}

export function parseQuery<S extends z.ZodTypeAny>(
  schema: S,
  request: Request
): z.infer<S> {
  return schema.parse(searchParamsObject(new URL(request.url)));
}
