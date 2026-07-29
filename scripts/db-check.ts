import "dotenv/config";
import { closeMySqlPool, queryRows } from "@/lib/db/mysql";

type CountRow = {
  count_value: number;
};

type LatestSampleRow = {
  latest_sample_hour_utc: string | null;
};

const requiredTables = ["routes", "ingestion_runs", "route_samples"];

async function tableExists(tableName: string) {
  const rows = await queryRows<CountRow>(
    `
      SELECT COUNT(*) AS count_value
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name = ?
    `,
    [tableName]
  );
  return Number(rows[0]?.count_value ?? 0) > 0;
}

async function main() {
  const missing = [];
  for (const table of requiredTables) {
    if (!(await tableExists(table))) {
      missing.push(table);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required MySQL tables: ${missing.join(", ")}`);
  }

  const activeRoutes = await queryRows<CountRow>(`
    SELECT COUNT(*) AS count_value
    FROM routes
    WHERE active = 1
  `);
  const latestSample = await queryRows<LatestSampleRow>(`
    SELECT MAX(sample_hour_utc) AS latest_sample_hour_utc
    FROM route_samples
    WHERE traffic_source = 'live'
  `);

  console.log(
    JSON.stringify({
      event: "mysql_check_ok",
      activeRoutes: Number(activeRoutes[0]?.count_value ?? 0),
      latestLiveSampleHourUtc: latestSample[0]?.latest_sample_hour_utc ?? null
    })
  );
}

void main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        event: "mysql_check_failed",
        error: error instanceof Error ? error.message : String(error)
      })
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMySqlPool();
  });
