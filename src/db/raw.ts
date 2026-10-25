/**
 * Landing raw payloads. The body is stored exactly as Strava sent it (DuckDB parses the
 * JSON itself, so 64-bit ids keep their precision); a new raw_payload row is written
 * only when the content changed, and raw_latest always records the check.
 *
 * Bodies up to BLOB_CHUNK_BYTES live inline in raw_payload.body. Longer ones (streams,
 * long activity details) are split into chunks of at most that many bytes in raw_blob
 * and raw_payload.body is NULL; raw_current reassembles them. See schema.ts for why.
 */
import { createHash } from "node:crypto";
import { listValue } from "@duckdb/node-api";
import type { Tx } from "./database.js";
import { project } from "./projections.js";
import { BLOB_CHUNK_BYTES } from "./schema.js";

export interface LandResult {
  changed: boolean;
}

export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Split a body into parts of at most BLOB_CHUNK_BYTES bytes on UTF-8 character
 * boundaries, or return null when it fits inline.
 */
export function chunkBody(body: string): string[] | null {
  const buf = Buffer.from(body, "utf8");
  if (buf.length <= BLOB_CHUNK_BYTES) return null;
  const parts: string[] = [];
  for (let start = 0; start < buf.length; ) {
    let end = Math.min(start + BLOB_CHUNK_BYTES, buf.length);
    // Never cut inside a multi-byte sequence: continuation bytes are 10xxxxxx.
    while (end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
    parts.push(buf.subarray(start, end).toString("utf8"));
    start = end;
  }
  return parts;
}

/** Store one payload and, when it changed, rebuild the typed rows derived from it. */
export async function land(tx: Tx, type: string, key: string, body: string, at = new Date()): Promise<LandResult> {
  const changed = await store(tx, type, key, body, at);
  if (changed) await project(tx, type, [key]);
  return { changed };
}

/** Store many payloads of one type, then project the changed ones in one pass. Returns the changed keys. */
export async function landMany(
  tx: Tx,
  type: string,
  items: Array<{ key: string; body: string }>,
  at = new Date(),
): Promise<string[]> {
  const changed: string[] = [];
  for (const item of items) if (await store(tx, type, item.key, item.body, at)) changed.push(item.key);
  if (changed.length > 0) await project(tx, type, changed);
  return changed;
}

async function store(tx: Tx, type: string, key: string, body: string, at: Date): Promise<boolean> {
  const hash = hashBody(body);
  const prev = await tx.one<{ content_hash: string | null; status: string }>(
    "SELECT content_hash, status FROM raw_latest WHERE object_type = $1 AND object_key = $2",
    [type, key],
  );
  const changed = !prev || prev.content_hash !== hash || prev.status !== "ok";
  const iso = at.toISOString();
  if (!prev || prev.content_hash !== hash) {
    // The same content may have been stored before (an edit that was reverted), in
    // which case the existing row and its chunks are kept.
    const known = await tx.one(
      "SELECT 1 FROM raw_payload WHERE object_type = $1 AND object_key = $2 AND content_hash = $3",
      [type, key, hash],
    );
    if (!known) {
      const parts = chunkBody(body);
      await tx.run(
        `INSERT INTO raw_payload (object_type, object_key, content_hash, fetched_at, body)
         VALUES ($1, $2, $3, $4::TIMESTAMPTZ, $5::JSON)`,
        [type, key, hash, iso, parts ? null : body],
      );
      if (parts) {
        await tx.run(
          `INSERT INTO raw_blob (object_type, object_key, content_hash, chunk_no, part)
           SELECT $1, $2, $3, (i - 1)::INTEGER, p FROM unnest($4::VARCHAR[]) WITH ORDINALITY AS t(p, i)`,
          [type, key, hash, listValue(parts)],
        );
      }
    }
  }
  await tx.run(
    `INSERT OR REPLACE INTO raw_latest (object_type, object_key, status, content_hash, fetched_at, checked_at)
     VALUES ($1, $2, 'ok', $3, (SELECT fetched_at FROM raw_payload WHERE object_type = $1 AND object_key = $2 AND content_hash = $3), $4::TIMESTAMPTZ)`,
    [type, key, hash, iso],
  );
  return changed;
}

/** Record that Strava answered 404. The last good payload stays as history. */
export async function markNotFound(tx: Tx, type: string, key: string, at = new Date()): Promise<void> {
  const iso = at.toISOString();
  await tx.run(
    `INSERT INTO raw_latest (object_type, object_key, status, content_hash, fetched_at, checked_at)
     VALUES ($1, $2, 'not_found', NULL, NULL, $3::TIMESTAMPTZ)
     ON CONFLICT (object_type, object_key) DO UPDATE SET status = 'not_found', checked_at = excluded.checked_at`,
    [type, key, iso],
  );
  await project(tx, type, [key]);
}

export interface CurrentPayload {
  status: string;
  checked_at: string;
  fetched_at: string | null;
  body: string | null;
}

export async function current(tx: Tx, type: string, key: string): Promise<CurrentPayload | undefined> {
  return tx.one<CurrentPayload>(
    "SELECT status, checked_at, fetched_at, body FROM raw_current WHERE object_type = $1 AND object_key = $2",
    [type, key],
  );
}
