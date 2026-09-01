// ClamAV INSTREAM client. Fails CLOSED: any timeout, connection error or
// malformed reply is treated as "scanner unavailable" and rejects -- an
// unscanned file is never accepted.

import net from "node:net";

import { config } from "@/lib/config";

export class ScannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScannerUnavailableError";
  }
}

export interface ScanOptions {
  host?: string;
  port?: number;
  connectTimeoutMs?: number;
  scanTimeoutMs?: number;
}

const DEFAULTS = { connectTimeoutMs: 5_000, scanTimeoutMs: 30_000 };

/**
 * Scan a byte stream via `zINSTREAM`, sending it to ClamAV in chunks (never
 * buffering the whole file). Resolves `null` when clean, the signature name when
 * infected. Throws ScannerUnavailableError on any other outcome.
 */
export function scanStream(
  source: AsyncIterable<Uint8Array>,
  opts: ScanOptions = {},
): Promise<string | null> {
  const host = opts.host ?? config.clamavHost;
  const port = opts.port ?? config.clamavPort;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
  const scanTimeoutMs = opts.scanTimeoutMs ?? DEFAULTS.scanTimeoutMs;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = Buffer.alloc(0);
    let settled = false;
    let timer = setTimeout(() => fail("clamav connect timeout"), connectTimeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.destroy();
    };
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ScannerUnavailableError(message));
    };

    socket.on("connect", async () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail("clamav scan timeout"), scanTimeoutMs);
      try {
        socket.write(Buffer.from("zINSTREAM\0"));
        for await (const chunk of source) {
          if (settled) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (buf.length === 0) continue;
          const size = Buffer.alloc(4);
          size.writeUInt32BE(buf.length, 0);
          socket.write(size);
          socket.write(buf);
        }
        if (!settled) socket.write(Buffer.from([0, 0, 0, 0]));
      } catch {
        fail("clamav stream read error");
      }
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
    });
    socket.on("error", () => fail("clamav connection error"));
    socket.on("close", () => {
      const text = response.toString("utf8").replace(/\0/g, "").trim();
      if (/stream: OK$/.test(text)) return done(null);
      const found = text.match(/stream: (.+) FOUND$/);
      if (found) return done(found[1]);
      fail(`malformed clamav reply: ${text || "<empty>"}`);
    });
  });
}

/** Best-effort signature DB version (`zVERSION`). Null on any failure. */
export function scannerVersion(opts: ScanOptions = {}): Promise<string | null> {
  const host = opts.host ?? config.clamavHost;
  const port = opts.port ?? config.clamavPort;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, connectTimeoutMs);
    const finish = (value: string | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.on("connect", () => socket.write(Buffer.from("zVERSION\0")));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(response.replace(/\0/g, "").trim() || null));
  });
}
