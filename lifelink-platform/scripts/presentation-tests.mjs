// One command for presentation day: test database, test API and live test dashboard together.
// Usage: double-click start-test-dashboard.cmd in the repository root, or `node scripts/presentation-tests.mjs`.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboardUrl = "http://127.0.0.1:4321";
const children = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8", shell: process.platform === "win32" });

async function responds(url, expected) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.status === expected;
  } catch { return false; }
}

async function waitFor(check, seconds, label) {
  for (let i = 0; i < seconds; i += 1) {
    if (await check()) return true;
    await sleep(1000);
  }
  console.error(`  ${label} did not become ready within ${seconds} seconds.`);
  return false;
}

function start(name, script) {
  const child = spawn(process.execPath, [path.join("scripts", script)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { for (const line of String(chunk).split("\n")) if (line.trim()) console.log(`  [${name}] ${line}`); });
  }
  children.push(child);
  return child;
}

console.log("LifeLink live test dashboard\n");

console.log("1/4 Checking Docker…");
if (docker("info", "--format", "{{.ServerVersion}}").status !== 0) {
  console.error("  Docker is not running. Open Docker Desktop, wait until it says 'Engine running', then run this again.");
  process.exit(1);
}

console.log("2/4 Starting the test database…");
if (docker("start", "lifelink-test-db").status !== 0) {
  console.error("  The lifelink-test-db container does not exist yet. See docs/testing/testing-strategy.md, section 3.");
  process.exit(1);
}
if (!(await waitFor(async () => docker("exec", "lifelink-test-db", "pg_isready", "-U", "postgres").status === 0, 60, "The test database"))) process.exit(1);

console.log("3/4 Starting the test API on port 4100…");
if (await responds("http://127.0.0.1:4100/api/notifications", 401)) {
  console.log("  Already running, reusing it.");
} else {
  start("api", "start-test-api.mjs");
  if (!(await waitFor(() => responds("http://127.0.0.1:4100/api/notifications", 401), 90, "The test API"))) process.exit(1);
}

console.log("4/4 Starting the dashboard on port 4321…");
if (await responds(dashboardUrl, 200)) {
  console.log("  Already running, reusing it.");
} else {
  start("dashboard", "test-dashboard.mjs");
  if (!(await waitFor(() => responds(dashboardUrl, 200), 30, "The dashboard"))) process.exit(1);
}

console.log(`\nReady: ${dashboardUrl}`);
console.log("Keep this window open during the presentation. Close it (or press Ctrl+C) to stop.\n");
if (process.platform === "win32" && process.env.LIFELINK_NO_BROWSER !== "1") spawn("cmd", ["/c", "start", "", dashboardUrl], { detached: true, stdio: "ignore" }).unref();

function stopAll() {
  for (const child of children) child.kill();
  process.exit(0);
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
if (!children.length) process.exit(0);
