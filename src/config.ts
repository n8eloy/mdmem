// Runtime configuration: corpus roots, memory store and index location.
// Explicit flags and env variables win; otherwise the mdmem home's config.json is used.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const USAGE = `mdmem: no corpus configured.

Create a memory home (default ~/.mdmem, override with MDMEM_HOME):

    node src/cli.ts init
    node src/cli.ts add ~/notes

Or pass an explicit corpus, which bypasses the config file entirely:

    node src/server.ts  --roots ~/notes,~/work/docs
    node src/indexer.ts --roots ~/notes --db ~/notes/.mdmem/mem.db
    MDMEM_ROOTS=~/notes node src/indexer.ts

Optional --db <path> (or MDMEM_DB) sets the index location. It defaults to
<first-root>/.mdmem/mem.db with --roots, and to <home>/index.db otherwise.
`;

/** Read \`--name value\` or \`--name=value\` from the args after the script name. */
export function flag(name: string): string | undefined {
    const cliArguments = process.argv.slice(2);
    const index = cliArguments.indexOf(`--${name}`);
    const next = cliArguments.at(index + 1);
    if (index !== -1 && next && !next.startsWith('--')) {
        return next;
    }
    return cliArguments.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export function expand(target: string): string {
    const trimmed = target.trim();
    const home = trimmed === '~' || trimmed.startsWith('~/') ? path.join(homedir(), trimmed.slice(1)) : trimmed;
    return path.resolve(home);
}

/** The mdmem home: config.json, the default store and the default index live here. */
export function memoryHome(): string {
    return expand(process.env.MDMEM_HOME ?? path.join(homedir(), '.mdmem'));
}

export function configPath(): string {
    return path.join(memoryHome(), 'config.json');
}

/** On-disk config: the writable store plus any registered external directories. */
export interface StoredConfig {
    store: string;
    roots: string[];
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function readStoredConfig(): StoredConfig | undefined {
    const file = configPath();
    if (!existsSync(file)) {
        return undefined;
    }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
        throw new TypeError(`${file}: expected a JSON object`);
    }

    const { store, roots } = parsed as Record<string, unknown>;
    if (typeof store !== 'string') {
        throw new TypeError(`${file}: "store" must be an absolute path`);
    }
    return { store: expand(store), roots: (isStringArray(roots) ? roots : []).map((r) => expand(r)) };
}

export function writeStoredConfig(config: StoredConfig): void {
    mkdirSync(memoryHome(), { recursive: true });
    writeFileSync(configPath(), `${JSON.stringify(config, undefined, 4)}\n`);
}

interface Resolved {
    roots: string[];
    store: string | undefined;
    databasePath: string;
}

/** Memoized so a process sees one corpus even if the config file changes under it. */
const cache: { resolved?: Resolved } = {};

function resolve(): Resolved {
    if (cache.resolved) {
        return cache.resolved;
    }

    const explicitRoots = (flag('roots') ?? process.env.MDMEM_ROOTS ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => expand(r));
    const explicitDatabase = flag('db') ?? process.env.MDMEM_DB;
    if (explicitRoots.length > 0) {
        cache.resolved = {
            roots: explicitRoots,
            store: undefined,
            databasePath: expand(explicitDatabase ?? path.join(explicitRoots[0], '.mdmem', 'mem.db')),
        };
        return cache.resolved;
    }

    const stored = readStoredConfig();
    if (!stored) {
        process.stderr.write(USAGE);
        process.exit(1);
    }
    cache.resolved = {
        roots: [...new Set([stored.store, ...stored.roots])],
        store: stored.store,
        databasePath: expand(explicitDatabase ?? path.join(memoryHome(), 'index.db')),
    };
    return cache.resolved;
}

/** Absolute corpus roots; every `*.md` below them is indexed. */
export function corpusRoots(): string[] {
    return resolve().roots;
}

/** Where `memory_write` puts files. Undefined when the corpus came from --roots/MDMEM_ROOTS. */
export function storeDirectory(): string | undefined {
    return resolve().store;
}

export function databasePath(): string {
    return resolve().databasePath;
}

export function databaseDirectory(): string {
    return path.dirname(databasePath());
}
