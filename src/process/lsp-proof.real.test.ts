// #190989 shipped-entry proof over a REAL child process (Windows CI).
//
// Drives the production entry points end to end:
//   createBundleLspToolRuntime -> runtime.dispose() -> disposeAllBundleLspRuntimes()
//   -> createAgentCleanupScope receipts
//
// The LSP server is a real child process that completes the initialize
// handshake, then leaks a detached descendant that inherits the stdio pipes
// and escapes the owner's process-tree kill after the root exits. Disposal
// cannot certify descendant extinction, so closeOwnedStdioProcess() rejects;
// the fixed code keeps the session in activeBundleLspSessions and a later
// global sweep still observes the uncertainty.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  createBundleLspToolRuntime,
  disposeAllBundleLspRuntimes,
} from "../agents/agent-bundle-lsp-runtime.js";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";

// Fall back to plain spawn (no Job) so descendant-extinction cannot be
// certified on Windows, matching the issue's native-unavailable environment.
process.env.PROC_SAFE_NATIVE = "off";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(here, "../../scripts/lsp-fail-server.mjs");

function makeWorkspace() {
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
        "proof-server": { command: process.execPath, args: [serverScript] },
      },
    }),
  );
  return dir;
}

it("keeps failed cleanup discoverable for a later global sweep over a real child", async () => {
  const workspaceDir = makeWorkspace();
  const manifestRegistry = {
    plugins: [
      {
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
      },
    ],
    diagnostics: [],
  };
  let runtime: { dispose: () => Promise<void> } | undefined;
  try {
    console.log("== shipped-entry LSP cleanup proof over a real child process ==");
    console.log("platform:", process.platform, "pid:", process.pid);
    runtime = await createBundleLspToolRuntime({ workspaceDir, manifestRegistry });
    console.log("1. spawned LSP sessions:", runtime.sessions.length);
    expect(runtime.sessions).toHaveLength(1);

    const firstScope = createAgentCleanupScope();
    await firstScope.run(() => runtime!.dispose());
    console.log("2. first cleanup scope outcome =", firstScope.outcome);
    expect(firstScope.outcome).toBe("uncertain");

    const sweepScope = createAgentCleanupScope();
    await sweepScope.run(() => disposeAllBundleLspRuntimes());
    console.log("3. sweep scope outcome =", sweepScope.outcome);
    expect(sweepScope.outcome).toBe("uncertain");

    console.log("4. failed session stayed discoverable for the later global sweep");
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
});
