import { NextResponse } from "next/server";
import { getHeatmapRangeData } from "@/lib/data/heatmap-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);

  try {
    const data = await getHeatmapRangeData({
      startDate: url.searchParams.get("start"),
      endDate: url.searchParams.get("end")
    });

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid heatmap range" },
      { status: 400 }
    );
  }
}
