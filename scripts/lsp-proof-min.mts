// 最小可行性验证：真实 createOwnedStdioProcess 成功路径
// 在 windows-latest 上验证真实进程 supervisor 可用
import { createOwnedStdioProcess, closeOwnedStdioProcess } from "../src/process/owned-stdio.js";

const nodeScript = (source: string) => [process.execPath, "-e", source];

async function main() {
  console.log("== lsp-proof-min: real createOwnedStdioProcess on", process.platform, "==");
  const child = await createOwnedStdioProcess({
    argv: nodeScript(`process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("done\\n");
  process.exit(0);
});`),
    env: {},
    exactEnv: true,
  });
  console.log("spawned real child, pid:", child.pid);
  child.onStdout((chunk) => process.stdout.write("[child] " + chunk));
  child.onStderr((chunk) => process.stderr.write("[child-err] " + chunk));
  const result = await closeOwnedStdioProcess(child, { force: false });
  console.log("closeOwnedStdioProcess resolved:", JSON.stringify(result));
  console.log("== minimal feasibility proof OK ==");
}

main().catch((e) => {
  console.error("== minimal feasibility proof FAILED ==");
  console.error(e);
  process.exit(1);
});
