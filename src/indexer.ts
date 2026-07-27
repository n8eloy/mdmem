// Incremental reindex of the markdown memory corpus into sqlite-vec.
// Files are the source of truth; this index is disposable.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { corpusRoots, databaseDirectory } from './config.ts';
import { embed, openDatabase } from './search.ts';

const MAX_BODY_LINES = 200;

interface Chunk {
    chunk_id: string;
    file_path: string;
    file_hash: string;
    mtime: number;
    mem_id: string;
    type: string;
    topic: string;
    status: string;
    heading: string | null;
    excerpt: string;
    text: string;
}

/** Lexicographic order, matching the default `Array#sort` comparison for strings. */
function byCodeUnit(a: string, b: string): number {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}

/** Every `*.md` below `directory`, skipping dot-directories and the index directory. */
function walk(directory: string, out: string[] = []): string[] {
    if (!existsSync(directory)) return out;
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (full === databaseDirectory() || entry.name.startsWith('.')) continue;
            walk(full, out);
        } else if (entry.name.endsWith('.md')) out.push(full);
    }
    return out;
}

/** Corpus: the configured roots, walked recursively. Users scope it by choosing roots. */
function corpus(): string[] {
    return [...new Set(corpusRoots().flatMap((root) => walk(root)))].toSorted(byCodeUnit);
}

/** Tolerant YAML-ish frontmatter reader: flat `key: value` pairs only. */
export function parseFrontmatter(raw: string): { meta: Record<string, string | undefined>; body: string } {
    if (!raw.startsWith('---\n')) return { meta: {}, body: raw };
    const end = raw.indexOf('\n---', 4);
    if (end === -1) return { meta: {}, body: raw };
    const meta: Record<string, string | undefined> = {};
    for (const line of raw.slice(4, end).split('\n')) {
        const colon = line.indexOf(':');
        if (colon === -1 || line.startsWith('#')) continue;
        const value = line
            .slice(colon + 1)
            .split('#', 1)[0]
            .trim()
            .replaceAll(/^["']|["']$/g, '');
        if (value) meta[line.slice(0, colon).trim()] = value;
    }
    const lineBreak = raw.indexOf('\n', end + 1);
    return { meta, body: lineBreak === -1 ? '' : raw.slice(lineBreak + 1) };
}

/** Stable fallback id: `<root name>/<root-relative path>` without extension. */
function fallbackId(file: string): string {
    const root = corpusRoots()
        .filter((r) => file.startsWith(r + path.sep))
        .toSorted((a, b) => b.length - a.length)[0];
    if (!root) return path.basename(file, '.md');
    const relativePath = path.relative(root, file).replace(/\.md$/, '').split(path.sep).join('/');
    return `${path.basename(root)}/${relativePath}`;
}

function chunkFile(file: string): Chunk[] {
    const stat = statSync(file);
    const raw = readFileSync(file, 'utf8');
    const hash = createHash('sha256').update(raw).digest('hex');
    const { meta, body } = parseFrontmatter(raw);
    const memId = meta.id ?? fallbackId(file);
    const base = {
        file_path: file,
        file_hash: hash,
        mtime: Math.floor(stat.mtimeMs),
        mem_id: memId,
        type: meta.type ?? 'unknown',
        topic: meta.topic ?? 'unknown',
        status: meta.status ?? 'unknown',
    };

    const lines = body.split('\n');
    const sections: { heading: string | null; text: string }[] = [];
    if (lines.length <= MAX_BODY_LINES) {
        sections.push({ heading: null, text: body });
    } else {
        let heading: string | null = null;
        let buffer: string[] = [];
        const flush = () => {
            if (buffer.join('').trim()) sections.push({ heading, text: buffer.join('\n') });
        };
        for (const line of lines) {
            if (/^##\s+/.test(line)) {
                flush();
                heading = line.replace(/^#+\s*/, '').trim();
                buffer = [line];
            } else buffer.push(line);
        }
        flush();
    }

    return sections.map((section, index) => {
        // Prepend identity so short chunks still carry topic signal into the embedding.
        const header = [memId, base.topic, section.heading].filter((v) => v && v !== 'unknown').join(' — ');
        return {
            ...base,
            chunk_id: `${fallbackId(file)}#${String(index)}`,
            heading: section.heading,
            excerpt: section.text.trim().slice(0, 300),
            text: `${header}\n${section.text}`.trim(),
        };
    });
}

interface KnownRow {
    file_path: string;
    file_hash: string;
    mtime: number;
}

/** Remove every row a file owns, from both the metadata table and the vector table. */
function dropFiles(files: string[]): void {
    const database = openDatabase();
    const dropFile = database.transaction((file: string) => {
        const rowids = database.prepare('SELECT rowid FROM chunks WHERE file_path = ?').all(file) as {
            rowid: number;
        }[];
        // vec0 rejects rowids bound as JS numbers (they arrive as doubles); bind BigInt.
        for (const { rowid } of rowids) database.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(BigInt(rowid));
        database.prepare('DELETE FROM chunks WHERE file_path = ?').run(file);
    });
    for (const file of files) dropFile(file);
}

/** Embed the chunks and insert them into both tables. */
async function insertChunks(pending: Chunk[]): Promise<void> {
    if (pending.length === 0) return;
    const database = openDatabase();
    const vectors = await embed(pending.map((c) => c.text));
    const insert = database.transaction(() => {
        const insertChunk = database.prepare(`
        INSERT INTO chunks (chunk_id, file_path, file_hash, mtime, mem_id, type, topic, status, heading, excerpt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
        const insertVector = database.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)');
        for (const [index, c] of pending.entries()) {
            const { lastInsertRowid } = insertChunk.run(
                c.chunk_id,
                c.file_path,
                c.file_hash,
                c.mtime,
                c.mem_id,
                c.type,
                c.topic,
                c.status,
                c.heading,
                c.excerpt,
            );
            const vector = vectors[index];
            insertVector.run(
                BigInt(lastInsertRowid),
                new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
            );
        }
    });
    insert();
}

/** Reindex a single file in place, without walking the corpus. */
export async function indexFile(file: string): Promise<void> {
    dropFiles([file]);
    await insertChunks(chunkFile(file));
}

export async function reindex(): Promise<{ changed: number; removed: number; total: number }> {
    const database = openDatabase();
    const files = corpus();
    const known = new Map<string, { hash: string; mtime: number }>();
    const knownRows = database.prepare('SELECT DISTINCT file_path, file_hash, mtime FROM chunks').all() as KnownRow[];
    for (const row of knownRows) {
        known.set(row.file_path, { hash: row.file_hash, mtime: row.mtime });
    }

    const stale: string[] = [];
    const pending: Chunk[] = [];
    for (const file of files) {
        const previous = known.get(file);
        const stat = statSync(file);
        if (previous?.mtime === Math.floor(stat.mtimeMs)) continue;
        const chunks = chunkFile(file);
        if (previous?.hash === chunks[0].file_hash) continue; // touched but unchanged
        stale.push(file);
        pending.push(...chunks);
    }

    const present = new Set(files);
    const gone: string[] = [];
    for (const file of known.keys()) {
        if (!present.has(file)) gone.push(file);
    }

    dropFiles([...stale, ...gone]);
    await insertChunks(pending);

    const { total } = database.prepare('SELECT COUNT(*) AS total FROM chunks').get() as { total: number };
    return { changed: stale.length, removed: gone.length, total };
}

if (process.argv[1]?.endsWith('indexer.ts')) {
    const stats = await reindex();
    process.stderr.write(
        `indexed ${String(stats.changed)} new/changed, removed ${String(stats.removed)}, total ${String(stats.total)} chunks\n`,
    );
    process.exit(0);
}
