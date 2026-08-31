// Unit tests for the private scanned document service.
//
// Runnable here: temp dirs + a fake ClamAV TCP server (node:net). No Docker.
// The metadata-persist transaction is stubbed via the `persist` injection seam;
// its DB assertions (and the download-route RLS 404) are deferred to Task 15.

import net from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const DOC_ROOT = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const p = require("node:path") as typeof import("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "doc-root-"));
  Object.assign(process.env, {
    DATABASE_URL: "postgres://app_runtime:test@localhost:5432/credit_system",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    DOCUMENT_ROOT: root,
    CLAMAV_HOST: "127.0.0.1",
    CLAMAV_PORT: "3310",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "credit-system",
    SMTP_PASS: "test-password",
  });
  return root;
});

import {
  DocumentRejectedError,
  storeDocument,
  type StoreDocumentInput,
} from "./service";
import { openObject } from "./storage";

// ---- fake ClamAV -----------------------------------------------------------

const servers: net.Server[] = [];

function listen(handler: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer(handler);
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    }),
  );
}

function replyingServer(verdict: string) {
  return (socket: net.Socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.includes("VERSION")) {
        socket.end("ClamAV 1.0.0/27000/test\0");
        return;
      }
      if (buf.includes("INSTREAM") && buf.subarray(-4).equals(Buffer.alloc(4))) {
        socket.end(verdict);
      }
    });
    socket.on("error", () => {});
  };
}

const silentServer = (socket: net.Socket) => {
  socket.on("data", () => {});
  socket.on("error", () => {});
};

const rudeServer = (socket: net.Socket) => socket.destroy();

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) => new Promise<void>((r) => s.close(() => r())),
    ),
  );
});

// ---- fixtures ------------------------------------------------------------------

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("\0\x10JFIF\0\x01\x01\0\0\x01\0\x01\0\0"),
  Buffer.from([0xff, 0xd9]),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("\0\0\0\rIHDR-stub-bytes"),
]);

const identity = { userId: randomUUID(), role: "client" as const };

function baseInput(over: Partial<StoreDocumentInput> = {}): StoreDocumentInput {
  return {
    buffer: PDF,
    declaredName: "documento.pdf",
    declaredMime: "application/pdf",
    uploaderId: identity.userId,
    identity,
    link: { opportunityId: randomUUID(), docType: "rg", docId: randomUUID() },
    ...over,
  };
}

const persisted: unknown[] = [];
const persist = async (stored: unknown) => {
  persisted.push(stored);
};

function run(over: Partial<StoreDocumentInput>, port?: number) {
  return storeDocument(baseInput(over), {
    persist,
    scan: port
      ? { host: "127.0.0.1", port, connectTimeoutMs: 300, scanTimeoutMs: 300 }
      : { host: "127.0.0.1", port: 1, connectTimeoutMs: 300, scanTimeoutMs: 300 },
  });
}

const quarantineFiles = () => readdirSync(path.join(DOC_ROOT, "quarantine"));

// ---- tests ------------------------------------------------------------------

describe("storeDocument – validation (no scanner needed)", () => {
  it("rejects oversize files while streaming", async () => {
    await expect(
      run({ buffer: Buffer.alloc(15 * 1024 * 1024 + 1, 0x20) }),
    ).rejects.toThrow(/15 MiB/);
    expect(quarantineFiles()).toHaveLength(0);
  });

  it("rejects extension / signature mismatch", async () => {
    await expect(
      run({ buffer: PNG, declaredName: "documento.pdf", declaredMime: "application/pdf" }),
    ).rejects.toBeInstanceOf(DocumentRejectedError);
    expect(quarantineFiles()).toHaveLength(0);
  });

  it("rejects declared-mime / signature mismatch", async () => {
    await expect(
      run({ buffer: PDF, declaredName: "documento.pdf", declaredMime: "image/png" }),
    ).rejects.toThrow(/tipo declarado/);
  });

  it("rejects polyglot prefixes", async () => {
    await expect(
      run({ buffer: Buffer.concat([Buffer.from("GIF89a"), PDF]) }),
    ).rejects.toThrow(/não suportado/);
    expect(quarantineFiles()).toHaveLength(0);
  });

  it("rejects path-traversal names", async () => {
    await expect(run({ declaredName: "../evil.pdf" })).rejects.toThrow(/inválido/);
  });
});

describe("storeDocument – scanner (fake ClamAV TCP server)", () => {
  it("fails closed on scanner timeout", async () => {
    const port = await listen(silentServer);
    await expect(run({}, port)).rejects.toThrow(/antivírus/);
    expect(quarantineFiles()).toHaveLength(0);
  });

  it("fails closed on scanner connection error", async () => {
    // port 1: nothing listening -> ECONNREFUSED
    await expect(run({})).rejects.toThrow(/antivírus/);
    expect(quarantineFiles()).toHaveLength(0);
  });

  it("rejects an infected result and deletes the quarantine file", async () => {
    const port = await listen(replyingServer("stream: Eicar-Test-Signature FOUND\0"));
    await expect(run({}, port)).rejects.toThrow(/segurança/);
    expect(quarantineFiles()).toHaveLength(0);
  });

  it("accepts a clean PDF: moves to objects/ and persists metadata", async () => {
    persisted.length = 0;
    const port = await listen(replyingServer("stream: OK\0"));
    const stored = await run({}, port);

    expect(stored.scanResult).toBe("clean");
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.objectKey).toBe(`${stored.id.slice(0, 2)}/${stored.id}`);
    expect(stored.detectedMime).toBe("application/pdf");
    expect(existsSync(path.join(DOC_ROOT, "objects", stored.objectKey))).toBe(true);
    expect(quarantineFiles()).toHaveLength(0);
    expect(persisted).toHaveLength(1);
  });

  it("accepts a clean JPEG signature", async () => {
    const port = await listen(replyingServer("stream: OK\0"));
    const stored = await run(
      { buffer: JPEG, declaredName: "foto.jpg", declaredMime: "image/jpeg" },
      port,
    );
    expect(stored.detectedMime).toBe("image/jpeg");
  });

  it("accepts a clean PNG signature", async () => {
    const port = await listen(replyingServer("stream: OK\0"));
    const stored = await run(
      { buffer: PNG, declaredName: "scan.png", declaredMime: "image/png" },
      port,
    );
    expect(stored.detectedMime).toBe("image/png");
  });
});

describe("openObject – traversal protection", () => {
  it("refuses keys that resolve outside objects/", async () => {
    await expect(openObject("../../../etc/passwd")).rejects.toThrow(/traversal/);
    await expect(openObject("..\\..\\secret")).rejects.toThrow(/traversal/);
  });

  // Deferred to Task 15 (needs real Postgres): GET /api/documents/[id] returns
  // 404 (not 403) for a row the caller cannot see under RLS.
});
