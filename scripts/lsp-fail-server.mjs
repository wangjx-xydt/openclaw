// Real LSP server child for the #190989 proof.
//
// Completes the LSP `initialize` handshake over stdio, then spawns a detached
// descendant that inherits this process's stdout/stderr write ends. The root
// then exits, re-parenting the detached descendant to the OS so the process
// owner can no longer reach it through the root's PID tree. The leaked
// descendant keeps the relay/supervisor's stdio pipes open, so the owner
// cannot certify descendant extinction when the session is disposed — the
// exact failure shape closeOwnedStdioProcess() throws.
import { spawn } from "node:child_process";

const decoder = new TextDecoder("utf-8", { fatal: true });
let buffer = Buffer.alloc(0);
let leaked = false;
const DETACHED_KEEP_ALIVE_MS = Number(process.env.LSP_DETACHED_KEEP_ALIVE_MS ?? 60000);

function encode(body) {
  const json = JSON.stringify(body);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function respond(id, result) {
  process.stdout.write(encode({ jsonrpc: "2.0", id, result }));
}

function leakAndExit() {
  if (leaked) {
    return;
  }
  leaked = true;
  // A detached descendant inheriting stdout/stderr keeps the owner's pipes
  // open after this root exits and re-parents the leak, out of reach of a
  // process-tree kill rooted at this process.
  const leak = spawn(process.execPath, ["-e", `
    process.stdout.on("error", () => {});
    process.stderr.on("error", () => {});
    const until = Date.now() + ${DETACHED_KEEP_ALIVE_MS};
    const tick = () => {
      process.stdout.write("leaked-line\\n");
      if (Date.now() < until) {
        setTimeout(tick, 500);
      } else {
        process.exit(0);
      }
    };
    tick();
  `], { stdio: ["ignore", "inherit", "inherit"], detached: true });
  leak.unref();
  // Exit after the leak is admitted; ownership of the pipes transfers to the
  // detached descendant.
  setTimeout(() => process.exit(0), 50);
}

function handleMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.method === "initialize") {
    respond(message.id, {
      capabilities: {
        textDocument: { hover: { contentFormat: ["plaintext"] } },
      },
      serverInfo: { name: "lsp-proof-fail-server", version: "1.0.0" },
    });
    leakAndExit();
  } else if (message.method === "shutdown") {
    respond(message.id, null);
  } else if (message.method === "exit") {
    process.exit(0);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length: (\d+)/i.exec(header);
    if (!match) {
      return;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) {
      return;
    }
    let body;
    try {
      body = decoder.decode(buffer.subarray(start, start + length));
    } catch {
      return;
    }
    buffer = buffer.subarray(start + length);
    try {
      handleMessage(JSON.parse(body));
    } catch {
      // Ignore malformed messages; the handshake proof only needs initialize.
    }
  }
});

process.stdin.resume();
