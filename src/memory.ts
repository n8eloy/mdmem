// Writing memories into the store. Everything ends up as a plain markdown file
// with generated frontmatter; the file is the record, the index is derived.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { storeDirectory } from './config.ts';
import { indexFile, parseFrontmatter } from './indexer.ts';

const MAX_SLUG_LENGTH = 60;

export interface MemoryWriteInput {
    topic: string;
    kind: 'state' | 'log';
    content: string;
    slug?: string;
}

export interface MemoryWriteResult {
    id: string;
    type: 'state' | 'log';
    topic: string;
    path: string;
    replaced: boolean;
}

/** Reduce arbitrary text to `[a-z0-9-]`. Returns an empty string when nothing survives. */
export function slugify(value: string): string {
    return value
        .toLowerCase()
        .replaceAll(/[^\da-z]+/g, '-')
        .slice(0, MAX_SLUG_LENGTH)
        .replaceAll(/^-+|-+$/g, '');
}

/** Name a log entry after its first heading, or after the opening words of the body. */
function derivedSlug(content: string): string {
    const heading = /^#{1,6}\s+(?<title>.+)$/m.exec(content)?.groups?.title;
    return slugify(heading ?? content.split(/\s+/).slice(0, 8).join(' ')) || 'note';
}

function frontmatter(fields: [string, string][]): string {
    return ['---', ...fields.map(([key, value]) => `${key}: ${value}`), '---', ''].join('\n');
}

function writeNote(file: string, fields: [string, string][], body: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${frontmatter(fields)}\n${body}\n`);
}

export async function writeMemory(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    const store = storeDirectory();
    if (!store) {
        throw new Error('no mdmem store configured: run `mdmem init` (an explicit --roots corpus is read-only)');
    }
    const topic = slugify(input.topic);
    if (!topic) throw new Error(`invalid topic: ${JSON.stringify(input.topic)}`);
    const body = input.content.trim();
    if (!body) throw new Error('content is empty');
    const clock = new Date();
    const now = clock.toISOString();

    if (input.kind === 'state') {
        const file = path.join(store, topic, 'state.md');
        const previous = existsSync(file) ? parseFrontmatter(readFileSync(file, 'utf8')).meta : {};
        const id = `${topic}-state`;
        const fields: [string, string][] = [
            ['id', id],
            ['type', 'state'],
            ['topic', topic],
            ['created', previous.created ?? now],
        ];
        if (previous.created) fields.push(['updated', now]);
        fields.push(['status', 'active']);
        writeNote(file, fields, body);
        await indexFile(file);
        return { id, type: 'state', topic, path: file, replaced: Boolean(previous.created) };
    }

    const requested = input.slug === undefined ? derivedSlug(body) : slugify(input.slug);
    if (!requested) throw new Error(`invalid slug: ${JSON.stringify(input.slug)}`);
    const directory = path.join(store, topic, 'log');
    const base = `${now.slice(0, 10)}-${requested}`;
    // Log entries are never overwritten; collisions get a numeric suffix.
    let stem = base;
    for (let attempt = 2; existsSync(path.join(directory, `${stem}.md`)); attempt += 1) {
        stem = `${base}-${String(attempt)}`;
    }
    const file = path.join(directory, `${stem}.md`);
    const id = `${topic}-${stem}`;
    writeNote(
        file,
        [
            ['id', id],
            ['type', 'log'],
            ['topic', topic],
            ['created', now],
            ['status', 'active'],
        ],
        body,
    );
    await indexFile(file);
    return { id, type: 'log', topic, path: file, replaced: false };
}
