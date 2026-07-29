export const DEFAULT_RETENTION_DAYS = 90;

type RetentionEnv = {
  [key: string]: string | undefined;
  RETENTION_DAYS?: string;
};

export function getRetentionDays(env: RetentionEnv = process.env) {
  const rawValue = env.RETENTION_DAYS;
  if (!rawValue) {
    return DEFAULT_RETENTION_DAYS;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_RETENTION_DAYS;
  }

  return parsed;
}
