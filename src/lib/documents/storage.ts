// Filesystem layer for private scanned documents.
//
// Layout under config.documentRoot:
//   quarantine/<uuid>            unscanned upload, fsync'd
//   objects/<first-two>/<uuid>   clean, committed object
//
// Absolute paths never leave this module -- callers hold the relative object key
// (`<first-two>/<uuid>`) only.

import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { config } from "@/lib/config";

const objectsRoot = () => path.resolve(config.documentRoot, "objects");
const quarantineRoot = () => path.resolve(config.documentRoot, "quarantine");

export function objectKey(id: string): string {
  return `${id.slice(0, 2)}/${id}`;
}

/**
 * Stream `chunks` into quarantine/<id>, calling `inspect` on every chunk so the
 * caller can enforce size / magic-byte rules while streaming. If `inspect`
 * throws (or any I/O fails) the partial file is removed and the error rethrown.
 * Returns the total byte count. fsync before returning.
 */
export async function writeQuarantine(
  id: string,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  inspect: (chunk: Buffer, bytesSoFar: number) => void,
): Promise<number> {
  await mkdir(quarantineRoot(), { recursive: true });
  const dest = path.join(quarantineRoot(), id);
  const handle = await open(dest, "wx");
  let total = 0;
  try {
    for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      inspect(buf, total);
      await handle.write(buf);
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(dest, { force: true });
    throw error;
  }
  await handle.close();
  return total;
}

export async function readQuarantine(id: string): Promise<Buffer> {
  return readFile(path.join(quarantineRoot(), id));
}

/** Atomic move quarantine/<id> -> objects/<key>. Returns the relative key. */
export async function commitQuarantine(id: string): Promise<string> {
  const key = objectKey(id);
  const dest = path.join(objectsRoot(), key);
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(path.join(quarantineRoot(), id), dest);
  return key;
}

export async function removeQuarantine(id: string): Promise<void> {
  await rm(path.join(quarantineRoot(), id), { force: true });
}

/**
 * Open a committed object by its stored key, read-only, with traversal
 * protection: the resolved path must sit inside objects/.
 */
export async function openObject(key: string) {
  const resolved = path.resolve(objectsRoot(), key);
  const base = objectsRoot();
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("path traversal detected");
  }
  return open(resolved, constants.O_RDONLY);
}
