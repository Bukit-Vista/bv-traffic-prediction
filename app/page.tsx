import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { getSourceDashboardData, unavailableSourceDashboard } from "@/lib/api/bootstrap";
import {
  catchmentPreviewFlagEnabled,
  catchmentPublicFlagEnabled
} from "@/lib/api/internal-catchment-preview";
import { getBasemapConfig } from "@/lib/map/config";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const sourceDashboardEnabled = process.env.BALI_SOURCE_DASHBOARD_ENABLED === "true" ||
    (process.env.NODE_ENV !== "production" && process.env.BALI_SOURCE_DASHBOARD_ENABLED !== "false");
  const data = sourceDashboardEnabled
    ? await getSourceDashboardData().catch(() => unavailableSourceDashboard())
    : unavailableSourceDashboard();
  const airportTourismRoutesEnabled = sourceDashboardEnabled && process.env.AIRPORT_TOURISM_ROUTES_ENABLED !== "false";
  const mobilityShadowUiEnabled = process.env.MOBILITY_SHADOW_UI_ENABLED === "true" ||
    (process.env.NODE_ENV !== "production" && process.env.MOBILITY_SHADOW_UI_ENABLED !== "false");
  const mobilityPlacesLayerEnabled = process.env.MOBILITY_PLACES_LAYER_ENABLED === "true" ||
    (process.env.NODE_ENV !== "production" && process.env.MOBILITY_PLACES_LAYER_ENABLED !== "false");
  const mobilityCatchmentPreviewEnabled = catchmentPreviewFlagEnabled();
  const mobilityCatchmentV2PublicEnabled = catchmentPublicFlagEnabled();
  return <DashboardShell initialData={data} basemapConfig={getBasemapConfig()} airportTourismRoutesEnabled={airportTourismRoutesEnabled} mobilityShadowUiEnabled={mobilityShadowUiEnabled} mobilityPlacesLayerEnabled={mobilityPlacesLayerEnabled} mobilityCatchmentPreviewEnabled={mobilityCatchmentPreviewEnabled} mobilityCatchmentV2PublicEnabled={mobilityCatchmentV2PublicEnabled} />;
}
