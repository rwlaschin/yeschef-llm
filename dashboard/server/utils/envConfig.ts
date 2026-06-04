// Resolves per-environment settings from the dev/prod toggle.
// Two settings each (local | production); pass `env` from the UI toggle.
// For now both point at the same place (production), but the structure is here.

export type AppEnv = "local" | "production";

export function resolveEnv(env?: string) {
  const prod = env === "production";
  const pick = (base: string, prodKey: string) =>
    prod ? process.env[prodKey] || process.env[base] : process.env[base];

  return {
    env: (prod ? "production" : "local") as AppEnv,
    mongoUri: pick("MONGO_URI", "MONGO_URI_PROD"),
    mongoDb: pick("MONGO_DB", "MONGO_DB_PROD") || "yeschef",
    graphqlEndpoint: pick("GRAPHQL_ENDPOINT", "GRAPHQL_ENDPOINT_PROD"),
  };
}
