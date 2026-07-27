// Shared layer: DB handle, embeddings, and vector search.
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { pipeline } from '@huggingface/transformers';
import { databaseDirectory, databasePath } from './config.ts';

export const DIM = 384;

export interface Hit {
    id: string;
    path: string;
    type: string | null;
    topic: string | null;
    heading: string | null;
    score: number;
    excerpt: string | null;
}

type Extractor = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

/** Lazily created singletons, held on an object so functions never rebind module bindings. */
const cache: { database?: Database.Database; extractor?: Extractor } = {};

export function openDatabase(): Database.Database {
    if (cache.database) return cache.database;
    mkdirSync(databaseDirectory(), { recursive: true });
    const handle = new Database(databasePath());
    sqliteVec.load(handle);
    handle.pragma('journal_mode = WAL');
    handle.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      chunk_id  TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      mtime     INTEGER NOT NULL,
      mem_id    TEXT,
      type      TEXT,
      topic     TEXT,
      status    TEXT,
      heading   TEXT,
      excerpt   TEXT
    );
    CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_path);
    CREATE INDEX IF NOT EXISTS chunks_mem  ON chunks(mem_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${String(DIM)}]);
  `);
    cache.database = handle;
    return handle;
}

async function getExtractor(): Promise<Extractor> {
    cache.extractor ??= await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'q8' });
    return cache.extractor;
}

/** Mean-pooled, L2-normalized 384-dim embeddings. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
    const pipe = await getExtractor();
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    const flat = out.data as Float32Array;
    return texts.map((_, index) => Float32Array.from(flat.slice(index * DIM, (index + 1) * DIM)));
}

interface SearchRow {
    chunk_id: string;
    file_path: string;
    mem_id: string | null;
    type: string | null;
    topic: string | null;
    heading: string | null;
    excerpt: string | null;
    distance: number;
}

export async function search(query: string, k = 8, filters: { type?: string; topic?: string } = {}): Promise<Hit[]> {
    const conn = openDatabase();
    // BGE v1.5 retrieval instruction: prefix queries (not passages) per the model card.
    const [vector] = await embed([`Represent this sentence for searching relevant passages: ${query}`]);
    const isFiltered = Boolean(filters.type) || Boolean(filters.topic);
    // vec0 KNN cannot be joined with arbitrary predicates, so over-fetch then filter.
    const fetchK = isFiltered ? Math.max(k * 8, 64) : k;
    const rows = conn
        .prepare(
            `
      SELECT c.chunk_id, c.file_path, c.mem_id, c.type, c.topic, c.heading, c.excerpt, v.distance
      FROM vec_chunks v
      JOIN chunks c ON c.rowid = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `,
        )
        .all(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), fetchK) as SearchRow[];

    return rows
        .filter((r) => (!filters.type || r.type === filters.type) && (!filters.topic || r.topic === filters.topic))
        .slice(0, k)
        .map((r) => ({
            id: r.mem_id ?? r.chunk_id,
            path: r.file_path,
            type: r.type,
            topic: r.topic,
            heading: r.heading,
            // vectors are unit-length, so cosine similarity = 1 - L2^2/2
            score: Number((1 - (r.distance * r.distance) / 2).toFixed(4)),
            excerpt: r.excerpt,
        }));
}

/** Resolve a mem_id or chunk_id to its source file path. */
export function resolvePath(id: string): string | null {
    const conn = openDatabase();
    const row = conn.prepare('SELECT file_path FROM chunks WHERE mem_id = ? OR chunk_id = ? LIMIT 1').get(id, id) as
        { file_path: string } | undefined;
    return row?.file_path ?? null;
}
