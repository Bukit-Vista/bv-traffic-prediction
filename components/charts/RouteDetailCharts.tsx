"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Bar,
  BarChart
} from "recharts";

type TodayPoint = {
  hour: number;
  sampleHour: string;
  currentMinutes: number;
  normalMinutes: number;
};

type HistoryPoint = {
  sampleHour: string;
  score: number | null;
};

type HourAverage = {
  hour: number;
  score: number | null;
  count: number;
};

export function RouteDetailCharts({
  today,
  history,
  hourlyAverage,
  retentionDays
}: {
  today: TodayPoint[];
  history: HistoryPoint[];
  hourlyAverage: HourAverage[];
  retentionDays: number;
}) {
  return (
    <div className="grid gap-8">
      <ChartShell title="Today travel time">
        {today.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={today}>
              <CartesianGrid stroke="#d8e0e6" />
              <XAxis dataKey="hour" tickFormatter={(hour) => `${hour}:00`} />
              <YAxis unit="m" />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="currentMinutes"
                name="Current"
                stroke="#b9382f"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="normalMinutes"
                name="Normal"
                stroke="#177245"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartShell>

      <ChartShell title={`${retentionDays}-day congestion ratio`}>
        {history.length === 0 ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={history}>
              <CartesianGrid stroke="#d8e0e6" />
              <XAxis
                dataKey="sampleHour"
                tickFormatter={(value) =>
                  new Date(value).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric"
                  })
                }
              />
              <YAxis domain={[1, "auto"]} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="score"
                name="Score"
                stroke="#1d4ed8"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartShell>

      <ChartShell title="Average congestion by WITA hour">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={hourlyAverage}>
            <CartesianGrid stroke="#d8e0e6" />
            <XAxis dataKey="hour" tickFormatter={(hour) => `${hour}:00`} />
            <YAxis domain={[1, "auto"]} />
            <Tooltip />
            <Bar dataKey="score" name="Average score" fill="#177245" />
          </BarChart>
        </ResponsiveContainer>
      </ChartShell>
    </div>
  );
}

function ChartShell({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-line bg-white p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-[300px] items-center justify-center border border-dashed border-line text-sm text-muted">
      No samples for this period.
    </div>
  );
}
