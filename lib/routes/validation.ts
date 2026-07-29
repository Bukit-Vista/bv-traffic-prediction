import { z } from "zod";

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

export const routeCreateSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  originLabel: z.string().trim().min(1).max(120),
  originLat: latitude,
  originLng: longitude,
  destinationLabel: z.string().trim().min(1).max(120),
  destinationLat: latitude,
  destinationLng: longitude,
  category: z.string().trim().min(1).max(80),
  active: z.boolean().optional().default(true)
});

export const routeUpdateSchema = routeCreateSchema.partial();

export type RouteCreateInput = z.infer<typeof routeCreateSchema>;
export type RouteUpdateInput = z.infer<typeof routeUpdateSchema>;

export function slugifyRoute(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
