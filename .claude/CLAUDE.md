# mdmem

Small tooling for local agentic memory management: a memory system storing plain
markdown files, with an MCP server (search, get, write, reindex), a CLI
(init/add/index/search/list), and a sqlite-vec index derived from the files.
See README.md for usage.

- Config resolution order: `--roots`/`--db` flags and env (read-only corpus, bypasses
  config) > `$MDMEM_HOME/config.json` from `mdmem init` (corpus = store + roots, db =
  home/index.db) > error. `memory_write` requires a configured store; it must refuse in
  flags mode.
- `memory_write` semantics are contractual: `state` replaces `<store>/<topic>/state.md`;
  `log` never overwrites (dated file + numeric suffix on collision); frontmatter is
  generated; the written file is indexed immediately, not via full reindex.

## Engineering rules

- TypeScript only, erasable syntax only (no enums, no namespaces, no parameter
  properties). Everything runs directly with `node src/<file>.ts` on Node >= 22.18.
  There is no build step; do not add one.
- Keep the codebase small and readable. The whole of `src/` is a few hundred lines and
  should stay that way. No new dependencies without a concrete need.
- The markdown files are the source of truth. The index must always be safe to delete
  and rebuild. Never store data that exists only in the database.
- Configuration comes from `--roots`/`--db` flags or `MDMEM_ROOTS`/`MDMEM_DB` env
  variables. Never hardcode machine-specific paths.
- Embedding model is `Xenova/bge-small-en-v1.5` q8 with the BGE query instruction
  prefix on queries only. Do not switch to `bge-base` q8: its quantization produces
  near-degenerate embeddings (verified 2026-07-26).
- Native dependency builds are allowlisted in `pnpm-workspace.yaml` (`better-sqlite3`,
  `onnxruntime-node`). pnpm ignores the equivalent package.json field.
- sqlite-vec rowids must be bound as BigInt. The MCP server must drain in-flight calls
  before exiting on stdin close.

## Verification

After any change: `pnpm install`, run `node src/indexer.ts --roots <real dir>` against
real markdown, run a real search, and smoke-test the MCP server over stdio
(initialize + tools/list). Report actual output, not intent.

## Writing style

Prose in this repo (README, comments, commits) is plain and neutral: complete
sentences, no marketing cadence, no sentence fragments, no unnecessary em dashes.
Commits follow Conventional Commits and are signed.
