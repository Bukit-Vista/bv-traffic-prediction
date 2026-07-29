import { createPool, type Pool, type PoolOptions, type RowDataPacket } from "mysql2/promise";

export type MySqlConfig = {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
};

export type MySqlEnv = {
  [key: string]: string | undefined;
  MYSQL_HOST?: string;
  MYSQL_PORT?: string;
  MYSQL_USER?: string;
  MYSQL_PASSWORD?: string;
  MYSQL_DATABASE?: string;
  MYSQL_CONNECTION_LIMIT?: string;
  MYSQL_QUERY_TIMEOUT_MS?: string;
};

export type QueryRows = <T extends object = Record<string, unknown>>(
  sql: string,
  values?: readonly unknown[]
) => Promise<T[]>;

let singletonPool: Pool | null = null;
let grantValidation: Promise<void> | null = null;

export function hasMutationPrivileges(grantText: string) {
  return /\b(?:ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|EXECUTE|GRANT OPTION)\b/i.test(grantText);
}

async function ensureReadOnlyAccount(pool: Pool, env: MySqlEnv = process.env) {
  if (env.NODE_ENV !== "production") return;
  grantValidation ??= pool.query<RowDataPacket[]>("SHOW GRANTS").then(([rows]) => {
    const grants = rows.flatMap((row) => Object.values(row)).join(" ");
    if (!/\bSELECT\b/i.test(grants) || hasMutationPrivileges(grants)) {
      const error = new Error("The configured MySQL application account does not satisfy the SELECT-only policy.") as Error & { code: string };
      error.code = "DB_ACCOUNT_NOT_READ_ONLY";
      throw error;
    }
  }).catch((error) => {
    grantValidation = null;
    throw error;
  });
  await grantValidation;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function getMySqlRuntimeConfig(env: MySqlEnv = process.env) {
  return {
    connectionLimit: boundedInteger(env.MYSQL_CONNECTION_LIMIT, 6, 1, 20),
    queryTimeoutMs: boundedInteger(env.MYSQL_QUERY_TIMEOUT_MS, 15_000, 1_000, 30_000)
  };
}

function parsePort(value: string | undefined) {
  if (!value) {
    return 3306;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Unsupported MYSQL_PORT value: ${value}`);
  }

  return parsed;
}

function missingMySqlEnv(env: MySqlEnv) {
  return [
    ["MYSQL_HOST", env.MYSQL_HOST],
    ["MYSQL_USER", env.MYSQL_USER],
    ["MYSQL_DATABASE", env.MYSQL_DATABASE]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

export function getMySqlConfig(env: MySqlEnv = process.env): MySqlConfig {
  const missing = missingMySqlEnv(env);
  if (missing.length > 0) {
    throw new Error(
      `Missing MySQL configuration: set ${missing.join(", ")}`
    );
  }

  return {
    host: env.MYSQL_HOST as string,
    port: parsePort(env.MYSQL_PORT),
    user: env.MYSQL_USER as string,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE as string
  };
}

function poolOptions(config: MySqlConfig, env: MySqlEnv = process.env): PoolOptions {
  const runtime = getMySqlRuntimeConfig(env);
  const shared = {
    waitForConnections: true,
    connectionLimit: runtime.connectionLimit,
    maxIdle: runtime.connectionLimit,
    idleTimeout: 60_000,
    queueLimit: 100,
    connectTimeout: 15_000,
    enableKeepAlive: true,
    namedPlaceholders: false,
    dateStrings: true as const
  };

  return {
    ...shared,
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database
  };
}

export function getMySqlPool() {
  singletonPool ??= createPool(poolOptions(getMySqlConfig()));
  return singletonPool;
}

export async function closeMySqlPool() {
  if (singletonPool) {
    await singletonPool.end();
    singletonPool = null;
    grantValidation = null;
  }
}

export const queryRows = async <T extends object = Record<string, unknown>>(
  sql: string,
  values: readonly unknown[] = []
): Promise<T[]> => {
  const pool = getMySqlPool();
  await ensureReadOnlyAccount(pool);
  const [rows] = await pool.execute<RowDataPacket[]>({
    sql,
    values: [...values] as never[],
    timeout: getMySqlRuntimeConfig().queryTimeoutMs
  });
  return rows as T[];
};

export function toMysqlDateTime(isoString: string) {
  return isoString.slice(0, 19).replace("T", " ");
}
