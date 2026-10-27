// Start the API on a separate port against the disposable test database.
// Gemini/Supabase keys are read from .env; DATABASE_URL is always replaced by LIFELINK_TEST_DATABASE_URL.
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readEnvFile(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return values;
}

const base = readEnvFile(path.join(root, ".env"));
const testEnv = { ...readEnvFile(path.join(root, ".env.test")), ...process.env };
const databaseUrl = testEnv.LIFELINK_TEST_DATABASE_URL;
if (!databaseUrl) {
  console.error("Set LIFELINK_TEST_DATABASE_URL in .env.test first (see docs/testing/testing-strategy.md).");
  process.exit(1);
}
const host = new URL(databaseUrl).hostname;
if (!["localhost", "127.0.0.1", "[::1]"].includes(host) && testEnv.LIFELINK_TEST_DATABASE_ALLOW_REMOTE !== "YES") {
  console.error(`Refusing to start the test API against "${host}". Use a local disposable database.`);
  process.exit(1);
}
const port = testEnv.LIFELINK_TEST_API_PORT ?? "4100";
delete base.DATABASE_URL;
const env = {
  ...process.env, ...base,
  DATABASE_URL: databaseUrl,
  PORT: port,
  NODE_ENV: "development",
  JWT_SECRET: `test-${randomUUID()}`,
  REDIS_URL: "",
  GEOCODING_ENDPOINT: "http://127.0.0.1:9/search",
};
console.log(`LifeLink test API starting on http://127.0.0.1:${port} (database: ${host})`);
const child = spawn(process.execPath, ["--require", "../../tests/tsx-userinfo-preload.cjs", "--import", "tsx", "src/server.ts"], {
  cwd: path.join(root, "apps", "api"), env, stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
