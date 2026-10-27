// node:test reporter that emits one JSON object per line for the live test dashboard.
function errorMessage(error) {
  if (!error) return undefined;
  const cause = error.cause ?? error;
  const text = typeof cause === "string" ? cause : cause.message ?? String(cause);
  return text.split("\n").filter((line) => line.trim()).slice(0, 4).join("\n").slice(0, 600);
}

export default async function* dashboardReporter(source) {
  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === "test:start") {
      yield `${JSON.stringify({ type: "start", name: data.name, nesting: data.nesting, file: data.file })}\n`;
    } else if (event.type === "test:pass" || event.type === "test:fail") {
      yield `${JSON.stringify({
        type: event.type === "test:pass" ? "pass" : "fail",
        name: data.name,
        nesting: data.nesting,
        file: data.file,
        suite: data.details?.type === "suite",
        todo: data.todo || undefined,
        skip: data.skip || undefined,
        duration: data.details?.duration_ms,
        error: event.type === "test:fail" ? errorMessage(data.details?.error) : undefined,
      })}\n`;
    } else if (event.type === "test:stdout" || event.type === "test:stderr") {
      const message = String(data.message ?? "");
      if (/scorecard/i.test(message)) yield `${JSON.stringify({ type: "log", message: message.trim() })}\n`;
    }
  }
}
