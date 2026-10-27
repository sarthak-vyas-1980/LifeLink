// Live test dashboard: run LifeLink's test layers from a browser and watch results stream in.
// Usage: npm run test:dashboard  ->  http://127.0.0.1:4321
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
if (existsSync(".env.test")) process.loadEnvFile(".env.test");

const port = Number(process.env.LIFELINK_DASHBOARD_PORT ?? 4321);
const reporter = pathToFileURL(path.join(root, "tests", "dashboard-reporter.mjs")).href;
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const filesOf = (script) => scripts[script].split(/\s+/).filter((token) => token.endsWith(".ts"));
const env = process.env;

async function apiReachable() {
  if (!env.LIFELINK_E2E_API_URL) return false;
  try {
    const response = await fetch(`${env.LIFELINK_E2E_API_URL.replace(/\/+$/, "")}/api/notifications`, { signal: AbortSignal.timeout(1500) });
    return response.status === 401;
  } catch { return false; }
}

const SUITES = [
  { id: "unit", label: "Unit tests", script: "test:unit", extra: [], description: "Rules in isolation: validation, state machines, matching, reservations, AI guardrails (simulated Gemini).",
    blocked: async () => false },
  { id: "integration", label: "Integration tests", script: "test:integration", extra: ["--test-concurrency=1"], description: "Real PostgreSQL: transactions, concurrent reservations, permissions, organ offers, HTTP routes.",
    blocked: async () => (env.LIFELINK_TEST_DATABASE_URL ? false : "Set LIFELINK_TEST_DATABASE_URL in .env.test") },
  { id: "e2e", label: "End-to-end tests", script: "test:e2e", extra: [], description: "The running API over HTTP and Socket.IO, exactly as the web app calls it.",
    blocked: async () => (!env.LIFELINK_E2E_API_URL || env.LIFELINK_E2E_ALLOW_WRITES !== "YES" ? "Set LIFELINK_E2E_API_URL and LIFELINK_E2E_ALLOW_WRITES=YES" : (await apiReachable()) ? false : "Start the test API: npm run test:api") },
  { id: "ai", label: "Live AI evaluation", script: "test:rag-eval", extra: [], description: "Real Gemini answers scored against hallucination, false-premise, clinical-safety and injection cases.",
    blocked: async () => (env.LIFELINK_RAG_EVAL !== "YES" ? "Set LIFELINK_RAG_EVAL=YES (uses Gemini quota)" : !env.LIFELINK_E2E_API_URL ? "Set LIFELINK_E2E_API_URL" : (await apiReachable()) ? false : "Start the test API: npm run test:api") },
];

let running = false;
const lastRuns = new Map(); // suite id -> events of its most recent run, for ?replay= snapshots

function runSuite(suite, send, onChild) {
  return new Promise((resolve) => {
    const args = ["--require", "./tests/tsx-userinfo-preload.cjs", "--import", "tsx", "--test", `--test-reporter=${reporter}`, "--test-reporter-destination=stdout", ...suite.extra, ...filesOf(suite.script)];
    const child = spawn(process.execPath, args, { cwd: root, env });
    onChild(child);
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim().startsWith("{")) send(line.trim());
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(readFileSync(path.join(root, "scripts", "test-dashboard.html"), "utf8"));
    return;
  }
  if (url.pathname === "/api/suites") {
    const suites = await Promise.all(SUITES.map(async (suite) => ({ id: suite.id, label: suite.label, description: suite.description, files: filesOf(suite.script).length, blocked: await suite.blocked() })));
    const databaseHost = env.LIFELINK_TEST_DATABASE_URL ? new URL(env.LIFELINK_TEST_DATABASE_URL).host : null;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ suites, databaseHost, apiUrl: env.LIFELINK_E2E_API_URL ?? null }));
    return;
  }
  if (url.pathname === "/api/last") {
    const events = lastRuns.get(url.searchParams.get("suite") ?? "") ?? [];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`[${events.join(",")}]`);
    return;
  }
  if (url.pathname === "/api/run") {
    if (running) { response.writeHead(409); response.end("A run is already in progress."); return; }
    const requested = url.searchParams.get("suite");
    const candidates = requested === "all" ? SUITES : SUITES.filter((suite) => suite.id === requested);
    const selected = [];
    for (const suite of candidates) if (!(await suite.blocked())) selected.push(suite);
    if (!selected.length) { response.writeHead(400); response.end("No runnable suite selected."); return; }
    running = true;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (json) => response.write(`data: ${json}\n\n`);
    let child;
    request.on("close", () => child?.kill());
    for (const suite of selected) {
      const recorded = [];
      const record = (json) => { recorded.push(json); send(json); };
      const startedAt = Date.now();
      record(JSON.stringify({ type: "suite-start", suite: suite.id, label: suite.label }));
      const code = await runSuite(suite, record, (spawned) => { child = spawned; });
      record(JSON.stringify({ type: "suite-end", suite: suite.id, code, durationMs: Date.now() - startedAt, finishedAt: new Date().toISOString() }));
      lastRuns.set(suite.id, recorded);
    }
    send(JSON.stringify({ type: "done" }));
    response.end();
    running = false;
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, "127.0.0.1", () => console.log(`LifeLink test dashboard: http://127.0.0.1:${port}`));
