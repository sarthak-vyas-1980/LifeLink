export interface ApiConfig {
  nodeEnv: string;
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string;
  redisUrl?: string;
}

let cachedConfig: ApiConfig | undefined;

// Load environment-backed service configuration and fail closed for auth secrets.
export function loadConfig(): ApiConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret && process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be configured in production.");
  }

  cachedConfig = {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 4000),
    jwtSecret: jwtSecret ?? "local-development-secret",
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "1h",
    redisUrl: process.env.REDIS_URL,
  };

  return cachedConfig;
}

// Expose the validated runtime configuration to API services.
export function getRuntimeConfig() {
  return loadConfig();
}
