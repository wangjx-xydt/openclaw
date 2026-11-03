// #190989 shipped-entry proof over REAL child processes (Linux CI).
//
// Drives the production entry points:
//   createBundleLspToolRuntime -> runtime.dispose() -> disposeAllBundleLspRuntimes()
//   -> createAgentCleanupScope receipts
//
// The LSP server is a real child process that completes the initialize
// handshake and then leaks a detached descendant holding the stdio pipes.
// Disposal cannot certify descendant extinction, so closeOwnedStdioProcess()
// rejects; the fixed code keeps the session in activeBundleLspSessions and a
// later global sweep still observes the uncertainty.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBundleLspToolRuntime, disposeAllBundleLspRuntimes } from "../src/agents/agent-bundle-lsp-runtime.js";
import { createAgentCleanupScope } from "../src/agents/run-cleanup-timeout.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(here, "lsp-fail-server.mjs");

function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lsp-proof-"));
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "proof-bundle", version: "1.0.0", lspServers: [".lsp.json"] }),
  );
  writeFileSync(
    path.join(dir, ".lsp.json"),
    JSON.stringify({
      lspServers: {
        "proof-server": {
          command: process.execPath,
          args: [serverScript],
        },
      },
    }),
  );
  return dir;
}

function makeRecord(workspaceDir: string) {
  return {
    id: "proof-bundle",
    channels: [],
    cliBackends: [],
    hooks: [],
    manifestPath: path.join(workspaceDir, ".claude-plugin", "plugin.json"),
    origin: "bundled",
    providers: [],
    rootDir: workspaceDir,
    skills: [],
    source: path.join(workspaceDir, "index.js"),
    format: "bundle",
    bundleFormat: "claude",
    enabledByDefault: true,
  };
}

function outcomeLabel(outcome: string): string {
  return outcome === "uncertain" ? "uncertain" : "closed";
}

async function main() {
  console.log("== shipped-entry LSP cleanup proof over real child processes ==");
  console.log("platform:", process.platform, "pid:", process.pid);
  console.log("lsp server script:", serverScript);

  const workspaceDir = makeWorkspace();
  let runtime;
  try {
    const manifestRegistry = { plugins: [makeRecord(workspaceDir)], diagnostics: [] };
    console.log("1. creating bundle LSP runtime through the production entry point");
    runtime = await createBundleLspToolRuntime({
      workspaceDir,
      manifestRegistry,
    });
    console.log("   -> spawned LSP sessions:", runtime.sessions.length, "tools:", runtime.tools.length);
    if (runtime.sessions.length !== 1) {
      throw new Error(`expected 1 LSP session, got ${runtime.sessions.length}`);
    }

    console.log("2. after runtime.dispose(): first cleanup scope outcome");
    const firstScope = createAgentCleanupScope();
    const first = await firstScope.run(() => runtime!.dispose());
    console.log("   -> first cleanup scope outcome =", outcomeLabel(firstScope.outcome));

    console.log("3. after disposeAllBundleLspRuntimes(): sweep scope outcome");
    const sweepScope = createAgentCleanupScope();
    const sweep = await sweepScope.run(() => disposeAllBundleLspRuntimes());
    console.log("   -> sweep scope outcome =", outcomeLabel(sweepScope.outcome));

    if (firstScope.outcome !== "uncertain") {
      throw new Error(`first cleanup scope should be uncertain, got ${firstScope.outcome}`);
    }
    if (sweepScope.outcome !== "uncertain") {
      throw new Error(`global sweep should observe uncertainty, got ${sweepScope.outcome}`);
    }
    console.log("   -> the failed session stayed discoverable for the later global sweep");
    console.log("== end proof ==");
  } finally {
    if (runtime) {
      await runtime.dispose().catch(() => undefined);
    }
    try {
      await disposeAllBundleLspRuntimes();
    } catch {
      // Best-effort sweep so the proof never leaves stray detached trees.
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("== proof FAILED ==");
  console.error(error);
  process.exit(1);
});
