// #190989 proof through the shipped Gateway close lifecycle (Windows CI).
//
// Creates a real bundle-LSP runtime whose child cannot certify descendant
// extinction (leaked detached descendant holding the stdio pipes), then closes
// the Gateway through the real production close path (prepareGatewayClose ->
// completeGatewayClose). The Gateway's real "bundle-lsp" shutdown step calls
// disposeAllBundleLspRuntimes, which must still observe the failed session and
// report cleanup uncertainty instead of a silent clean close.
import "./server-worker-free.test-support.js";
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
import { completeGatewayClose, prepareGatewayClose } from "./server-close.js";
import { createGatewayCloseTestDepsFactory } from "./server-close.test-support.js";

// Fall back to plain spawn (no Job) so descendant-extinction cannot be
// certified on Windows, matching the issue's native-unavailable environment.
process.env.PROC_SAFE_NATIVE = "off";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(here, "../../scripts/lsp-fail-server.mjs");

function makeWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "lsp-proof-gw-"));
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

const createGatewayCloseTestDeps = createGatewayCloseTestDepsFactory({
  disposeAllBundleLspRuntimes,
  stopGmailWatcher: async () => {},
  disposeAllCodeModeRuns: async () => {},
  closeProviderTransportDispatcherPool: async () => {},
  drainRetainedEmbeddingProviders: async () => {},
});

it("Gateway close reports cleanup uncertainty for a failed real LSP session", async () => {
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
    console.log("== shipped Gateway lifecycle LSP cleanup proof over a real child ==");
    console.log("platform:", process.platform, "pid:", process.pid);

    // 1. Real bundle-LSP runtime through the production entry point.
    runtime = await createBundleLspToolRuntime({ workspaceDir, manifestRegistry });
    console.log("1. spawned LSP sessions:", runtime.sessions.length);
    expect(runtime.sessions).toHaveLength(1);

    // 2. Dispose the runtime; the real child cannot certify extinction, so the
    //    session stays in the global active registry (this PR's fix).
    const firstScope = createAgentCleanupScope();
    await firstScope.run(() => runtime.dispose());
    console.log("2. runtime.dispose() cleanup scope outcome =", firstScope.outcome);
    expect(firstScope.outcome).toBe("uncertain");

    // 3. Close the Gateway through the real production close path. Its
    //    "bundle-lsp" shutdown step calls the real disposeAllBundleLspRuntimes,
    //    which must still see the failed session.
    const params = createGatewayCloseTestDeps();
    const preparation = await prepareGatewayClose(params, { reason: "proof" });
    await completeGatewayClose(params, preparation);
    console.log("3. Gateway close completed through the production close path");

    // 4. The failed session must still be discoverable after the Gateway close:
    //    a follow-up sweep observes the uncertainty, not a silent clean close.
    const sweepScope = createAgentCleanupScope();
    await sweepScope.run(() => disposeAllBundleLspRuntimes());
    console.log("4. follow-up sweep scope outcome =", sweepScope.outcome);
    expect(sweepScope.outcome).toBe("uncertain");

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
