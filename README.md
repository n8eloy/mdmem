# mdmem

Small tooling for local, markdown-based agentic memory management.

mdmem is a memory system for agents. Memories are stored as plain markdown files on disk, and an MCP server lets agents
write and search them. A SQLite vector index ([sqlite-vec](https://github.com/asg017/sqlite-vec)) provides the semantic
search; it is derived from the files and can be deleted and rebuilt at any time.

- The markdown files are the store. They can be read, edited, versioned, and grepped like any other files.
- Embeddings are computed in-process with [transformers.js](https://github.com/huggingface/transformers.js)
  (`bge-small-en-v1.5`, ~34MB, downloaded once and cached). After that initial download everything runs locally.
- TypeScript, executed directly by Node (≥ 22.18) without a build step.

Disclaimer: mdmem is experimental and has no stability guarantee. It is currently used for testing and local development
only.

## Getting started

To start on a fresh system, clone the repo, install dependencies, and run `init`:

```sh
git clone https://github.com/n8eloy/mdmem && cd mdmem
pnpm install

node src/cli.ts init
```

For use with Claude Code, add the MCP server to your `claude-mcp.json`:

```sh
claude mcp add --scope user mdmem -- node /path/to/mdmem/src/server.ts
```

`init` creates `~/.mdmem/` with a config file and an empty store. From the first message, an agent can save memories
with `memory_write` and recall them with `memory_search`. The same store is searchable from the terminal:

```sh
node src/cli.ts search "what did we decide about the api redesign"
```

For other AI clients, the equivalent MCP configuration is:

```json
{
    "mcpServers": {
        "mdmem": {
            "command": "node",
            "args": ["/path/to/mdmem/src/server.ts"]
        }
    }
}
```

## Migrating existing markdown

Existing notes can be brought in at any time. They are registered in place and indexed, so nothing is moved or copied:

```sh
node src/cli.ts add ~/notes ~/journal
```

Every `*.md` under a registered directory is indexed recursively (dot-directories are skipped) and becomes searchable
alongside the store.

## CLI

| Command                 | Effect                                                           |
| ----------------------- | ---------------------------------------------------------------- |
| `init [--store <dir>]`  | Create `~/.mdmem/` (config, store, index). Idempotent.           |
| `add <dir...>`          | Register existing markdown directories in place and index them.  |
| `index`                 | Incrementally reindex the store and all registered directories.  |
| `search <query> [-k N]` | Print ranked hits (score, id, path).                             |
| `list`                  | Print store path, registered directories, db path, chunk counts. |

## MCP tools

| Tool             | Input                                             | Returns                                                  |
| ---------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `memory_search`  | `query`, `k?`, `type?`, `topic?`                  | top-k `{id, path, type, topic, heading, score, excerpt}` |
| `memory_get`     | `id`                                              | full file content                                        |
| `memory_write`   | `topic`, `kind: state \| log`, `content`, `slug?` | `{id, type, path, replaced}`                             |
| `memory_reindex` | _none_                                            | incremental reindex stats                                |

`memory_write` creates plain markdown in the store, with generated frontmatter, and indexes it immediately:

- `kind: state` writes `<store>/<topic>/state.md`, replacing the previous content. One file per topic holds its current
  state.
- `kind: log` creates `<store>/<topic>/log/<date>-<slug>.md`. Log entries are never overwritten; name collisions get a
  numeric suffix.

Files written this way remain ordinary markdown and can be edited or deleted outside mdmem; the next reindex picks up
the change.

## Configuration

`mdmem init` writes `~/.mdmem/config.json` (the location can be changed with the `MDMEM_HOME` env variable):

```json
{
    "store": "/home/user/.mdmem/store",
    "roots": ["/home/user/notes"]
}
```

The searched corpus is the store plus the registered roots, and the index lives at `<home>/index.db`.

The `--roots` and `--db` flags (env: `MDMEM_ROOTS`, `MDMEM_DB`) bypass the config entirely and define the corpus
directly. This mode is read-only: `memory_write` refuses when no store is configured.

## Frontmatter

Files written by `memory_write` get frontmatter automatically. For registered external files it is optional: when a
file carries YAML frontmatter, `type` and `topic` become search filters and `id` becomes the file's stable identifier:

```yaml
---
id: myproj-2026-07-26-ci-migration
type: log
topic: myproj
---
```

## Reindexing

`memory_reindex` (or `node src/cli.ts index`) is incremental: unchanged files are detected by mtime and content hash
and skipped, and entries for deleted files are removed.

`scripts/reindex-hook.sh` is a ready-made hook target for Claude Code. It reads the hook payload, checks whether the
written file belongs to the corpus, and reindexes if so. With a config from `mdmem init` it needs no arguments, and
`MDMEM_ROOTS`/`MDMEM_DB` override it for flags-mode setups:

```json
{
    "matcher": "Write|Edit",
    "hooks": [
        {
            "type": "command",
            "async": true,
            "timeout": 120,
            "command": "/path/to/mdmem/scripts/reindex-hook.sh"
        }
    ]
}
```

## Notes

- The first run downloads the embedding model to the Hugging Face cache directory. After that, no network access is
  needed.
- `Xenova/bge-base-en-v1.5` q8 is not a drop-in upgrade: its quantization produces near-degenerate embeddings, with
  unrelated files tied at identical scores. `bge-small` q8 does not have this problem. Queries are prefixed with the BGE
  retrieval instruction from the model card; passages are not.
- Exact keyword lookups are better served by grep. Very vague queries can also miss at this model size.

## Related tools

For reference and study:

- [sqliteai/sqlite-memory](https://github.com/sqliteai/sqlite-memory) - C SQLite extension with hybrid (vector + FTS5)
  retrieval, markdown-aware chunking, and CRDT sync between agents. It has more retrieval features, but requires
  building the extension and supplying a GGUF model for llama.cpp.
- [sqliteai/sqlite-rag](https://github.com/sqliteai/sqlite-rag) - Python CLI for hybrid search over many document
  formats. Doesn't include an MCP server.
- [memweave](https://towardsdatascience.com/memweave-zero-infra-ai-agent-memory-with-markdown-and-sqlite-no-vector-database-required/) -
  Python based markdown and SQLite vector-based memory. No MCP server.

## License

MIT
