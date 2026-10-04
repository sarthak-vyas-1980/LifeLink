import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const workspaces = ["@lifelink/web", "@lifelink/api"];
const children = workspaces.map((workspace) =>
  spawn(npm, ["run", "dev", `--workspace=${workspace}`], {
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
);

for (const child of children) {
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      for (const runningChild of children) runningChild.kill();
      process.exitCode = code;
    }
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}
