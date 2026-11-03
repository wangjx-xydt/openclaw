// Real LSP server child for the #190989 proof.
//
// It completes the LSP `initialize` handshake over stdio, then spawns a
// detached descendant that keeps the root's stdout/stderr write ends open.
// The relay/supervisor cannot confirm descendant extinction for that detached
// tree, which is exactly the failure shape `closeOwnedStdioProcess()` throws
// when it cannot certify closure.
import { spawn } from "node:child_process";

const decoder = new TextDecoder("utf-8", { fatal: true });
let buffer = Buffer.alloc(0);
let keepAlive;
const DETACHED_KEEP_ALIVE_MS = Number(process.env.LSP_DETACHED_KEEP_ALIVE_MS ?? 30000);

function encode(body) {
  const json = JSON.stringify(body);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function respond(id, result) {
  process.stdout.write(encode({ jsonrpc: "2.0", id, result }));
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
    // After the handshake, leak a detached descendant that inherits this
    // process's stdout/stderr pipes. It keeps the relay's write ends open and
    // escapes the supervisor's process-group kill, so the owner cannot certify
    // descendant extinction when the session is disposed.
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
    keepAlive = setInterval(() => {}, 1000);
    keepAlive.unref?.();
  } else if (message.method === "shutdown") {
    respond(message.id, null);
  } else if (message.method === "exit") {
    clearInterval(keepAlive);
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
process.stdout.write(encode({ jsonrpc: "2.0", method: "initialized", params: {} }));
