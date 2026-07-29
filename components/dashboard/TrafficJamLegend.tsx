import { TRAFFIC_JAM_LEGEND } from "@/lib/map/traffic-heatmap";

export function TrafficJamLegend({ testId, compact = false }: { testId?: string; compact?: boolean }) {
  return (
    <div className={compact ? "w-[min(300px,calc(100vw-112px))]" : "w-full"} data-testid={testId} aria-label="Traffic congestion legend">
      <div className="mb-2 flex items-center justify-between gap-4">
        <span className="text-[10px] font-extrabold uppercase tracking-[0.13em] text-[#1b2c27]">Traffic congestion</span>
        <span className="flex items-center gap-1.5 text-[9px] font-bold text-[#873a34]"><span className="h-2 w-2 rounded-full bg-[#d95345] motion-safe:animate-pulse" />Darker = heavier jam</span>
      </div>
      <div className="grid grid-cols-6 gap-1">
        {TRAFFIC_JAM_LEGEND.map((stop) => (
          <div key={`${stop.value}-${stop.label}`} className="min-w-0 text-center" title={`${stop.value}: ${stop.label}`}>
            <span className="block h-2.5 rounded-sm" style={{ backgroundColor: stop.color }} />
            <span className="mt-1 block text-[9px] font-extrabold leading-none text-[#1b2c27]">{stop.value}</span>
            <span className="mt-1 block truncate text-[8px] font-semibold leading-none text-[#40534c]">{stop.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
