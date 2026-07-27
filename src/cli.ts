#!/usr/bin/env node
// mdmem CLI: create the memory home, register directories, index and search.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
    configPath,
    corpusRoots,
    databasePath,
    expand,
    flag,
    memoryHome,
    readStoredConfig,
    storeDirectory,
    writeStoredConfig,
} from './config.ts';
import { reindex } from './indexer.ts';
import { openDatabase, search } from './search.ts';

const USAGE = `mdmem <command>

  init [--store <dir>]    create the memory home (default ~/.mdmem, or MDMEM_HOME)
  add <dir>...            register directories in the corpus, then index them
  index                   incrementally reindex the whole corpus
  search <query> [-k N]   print ranked hits as "score  id  path"
  list                    print store, roots, index path and chunk counts

Global flags --roots and --db (or MDMEM_ROOTS/MDMEM_DB) override the config file.
`;

function out(line: string): void {
    process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
    process.stderr.write(`mdmem: ${message}\n`);
    process.exit(1);
}

/** Command arguments with flags and their values removed. */
function positionals(): string[] {
    const tokens = process.argv.slice(3);
    const values: string[] = [];
    let isFlagValue = false;
    for (const [index, token] of tokens.entries()) {
        if (isFlagValue) {
            isFlagValue = false;
        } else if (token.startsWith('-')) {
            const next = tokens.at(index + 1);
            isFlagValue = !token.includes('=') && next !== undefined && !next.startsWith('-');
        } else values.push(token);
    }
    return values;
}

function numberFlag(name: string, fallback: number): number {
    const tokens = process.argv.slice(3);
    const index = tokens.indexOf(name);
    if (index === -1) return fallback;
    const value = Number(tokens.at(index + 1));
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function chunkCount(prefix?: string): number {
    const database = openDatabase();
    const row = prefix
        ? database
              .prepare('SELECT COUNT(*) AS total FROM chunks WHERE substr(file_path, 1, ?) = ?')
              .get(prefix.length, prefix)
        : database.prepare('SELECT COUNT(*) AS total FROM chunks').get();
    return (row as { total: number }).total;
}

async function runIndex(): Promise<void> {
    const stats = await reindex();
    out(`indexed ${String(stats.changed)} new/changed, removed ${String(stats.removed)}, total ${String(stats.total)}`);
}

function runInit(): void {
    const home = memoryHome();
    const existing = readStoredConfig();
    const store = expand(flag('store') ?? existing?.store ?? path.join(home, 'store'));
    for (const directory of [home, store]) {
        out(`${existsSync(directory) ? 'exists ' : 'created'} ${directory}`);
        mkdirSync(directory, { recursive: true });
    }
    out(`${existing ? 'exists ' : 'created'} ${configPath()}`);
    writeStoredConfig({ store, roots: existing?.roots ?? [] });
}

async function runAdd(): Promise<void> {
    const directories = positionals().map((d) => expand(d));
    if (directories.length === 0) fail('add: expected at least one directory');
    const config = readStoredConfig();
    if (!config) fail(`no config at ${configPath()}: run \`mdmem init\` first`);
    for (const directory of directories) {
        if (!existsSync(directory) || !statSync(directory).isDirectory()) fail(`not a directory: ${directory}`);
    }
    const roots = new Set(config.roots);
    for (const directory of directories) roots.add(directory);
    writeStoredConfig({ ...config, roots: [...roots] });
    for (const directory of directories) out(`registered ${directory}`);
    await runIndex();
}

async function runSearch(): Promise<void> {
    const query = positionals().join(' ');
    if (!query) fail('search: expected a query');
    const hits = await search(query, numberFlag('-k', 8));
    for (const hit of hits) {
        out(`${hit.score.toFixed(4)}  ${hit.id}  ${hit.path}`);
    }
}

function runList(): void {
    out(`store  ${storeDirectory() ?? '(none; corpus came from --roots/MDMEM_ROOTS)'}`);
    for (const root of corpusRoots()) out(`root   ${root}  ${String(chunkCount(root + path.sep))} chunks`);
    out(`db     ${databasePath()}`);
    out(`total  ${String(chunkCount())} chunks`);
}

switch (process.argv[2]) {
    case 'init': {
        runInit();
        break;
    }
    case 'add': {
        await runAdd();
        break;
    }
    case 'index': {
        await runIndex();
        break;
    }
    case 'search': {
        await runSearch();
        break;
    }
    case 'list': {
        runList();
        break;
    }
    default: {
        process.stderr.write(USAGE);
        process.exit(1);
    }
}
process.exit(0);
