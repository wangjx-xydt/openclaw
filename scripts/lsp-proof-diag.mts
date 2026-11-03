// Diagnostic probe: does the subreaper anchor worker load and can a real
// child spawn on this runner? Mirrors what createOwnedStdioProcess does.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createOwnedStdioProcess, closeOwnedStdioProcess } from "../src/process/owned-stdio.js";
import { resolveRuntimeProcessEntrypointUrl } from "../src/infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerEnv } from "../src/infra/runtime-worker-url.js";
import { resolveLaunchableNodePath } from "../src/infra/stable-node-path.js";

const nodeScript = (source: string) => [process.execPath, "-e", source];

async function probeAnchor() {
  const workerUrl = resolveRuntimeProcessEntrypointUrl("serviceChildGroupAnchor");
  console.log("anchor worker url:", workerUrl.href);
  const executable = resolveLaunchableNodePath();
  console.log("launchable node:", executable);
  const argv = resolveRuntimeWorkerArgv(workerUrl, executable);
  console.log("anchor argv:", argv);
  const env = resolveRuntimeWorkerEnv(workerUrl, process.env);
  const child = spawn(executable, argv, { stdio: ["ignore", "ignore", "pipe", "ipc"], env });
  const stderr: string[] = [];
  child.stderr?.on("data", (d) => stderr.push(String(d)));
  const settled = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(-999), 8000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      console.log("anchor spawn error:", err.message);
      resolve(-1000);
    });
  });
  console.log("anchor exit code:", settled);
  if (stderr.length) {
    console.log("anchor stderr:", stderr.join(""));
  }
  try {
    child.disconnect?.();
  } catch {
    // ignore
  }
}

async function probeSuccessPath() {
  console.log("-- success path --");
  const child = await createOwnedStdioProcess({
    argv: nodeScript('process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("ok\\n"); process.exit(0); });'),
    env: {},
    exactEnv: true,
  });
  console.log("spawned child pid:", child.pid);
  child.onStdout((c) => process.stdout.write("[child] " + c));
  child.onStderr((c) => process.stderr.write("[child-err] " + c));
  const result = await closeOwnedStdioProcess(child, { force: false });
  console.log("closeOwnedStdioProcess resolved:", JSON.stringify(result));
  console.log("-- success path OK --");
}

async function main() {
  console.log("== lsp-proof diag on", process.platform, "==");
  console.log("process.execPath:", process.execPath);
  console.log("node version:", process.version);
  try {
    await probeAnchor();
  } catch (e) {
    console.error("probeAnchor failed:", e);
  }
  try {
    await probeSuccessPath();
  } catch (e) {
    console.error("probeSuccessPath failed:", e instanceof Error ? `${e.message}\n${e.stack}` : e);
  }
  console.log("== end diag ==");
}

main().catch((e) => {
  console.error("diag crashed:", e);
  process.exit(1);
});
