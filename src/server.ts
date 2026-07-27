#!/usr/bin/env node
// mdmem: MCP stdio server exposing semantic search over a markdown corpus.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolvePath, search } from './search.ts';
import { reindex } from './indexer.ts';
import { writeMemory } from './memory.ts';

const TOOLS = [
    {
        name: 'memory_search',
        description:
            'Semantic search over the local markdown corpus. Returns ranked chunks with ids, paths and excerpts; follow up by reading the path.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural-language query.' },
                k: { type: 'number', description: 'Max results (default 8).' },
                type: { type: 'string', description: 'Filter by frontmatter `type` value.' },
                topic: { type: 'string', description: 'Filter by frontmatter topic.' },
            },
            required: ['query'],
        },
    },
    {
        name: 'memory_get',
        description: 'Return the full markdown file content for a memory id or chunk id.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'mem_id or chunk_id from memory_search.' } },
            required: ['id'],
        },
    },
    {
        name: 'memory_write',
        description:
            'Write a memory into the mdmem store and index it immediately. `state` replaces <store>/<topic>/state.md with the current understanding of a topic; `log` adds a dated, never-overwritten entry under <store>/<topic>/log/. The result is a plain markdown file on disk with generated frontmatter, readable and editable outside mdmem.',
        inputSchema: {
            type: 'object',
            properties: {
                topic: { type: 'string', description: 'Topic slug, lowercase `[a-z0-9-]`, e.g. `myndra-ci`.' },
                kind: {
                    type: 'string',
                    enum: ['state', 'log'],
                    description: '`state` replaces the topic state file; `log` appends a dated entry.',
                },
                content: { type: 'string', description: 'Markdown body. Frontmatter is generated, do not include it.' },
                slug: {
                    type: 'string',
                    description: 'Log file name, defaulting to the first heading or opening words. Ignored for state.',
                },
            },
            required: ['topic', 'kind', 'content'],
        },
    },
    {
        name: 'memory_reindex',
        description: 'Rebuild the disposable index from the markdown files. Returns index stats.',
        inputSchema: { type: 'object', properties: {} },
    },
];

const server = new Server({ name: 'mdmem', version: '0.1.0' }, { capabilities: { tools: {} } });

// Exit when the client closes stdin, but only after in-flight calls have answered.
// Held on an object so the handlers below never rebind a module binding.
const state = { pending: 0, isStdinClosed: false };

const exitWhenDrained = () => {
    if (state.isStdinClosed && state.pending === 0) {
        process.exit(0);
    }
};

process.stdin.on('close', () => {
    state.isStdinClosed = true;
    exitWhenDrained();
});

function jsonResult(value: unknown): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(value, undefined, 2) }] };
}

/** Coerce an unvalidated tool argument to a string filter, dropping anything else. */
function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

type ToolArguments = Record<string, unknown>;

async function searchTool(toolArguments: ToolArguments): Promise<CallToolResult> {
    const requestedK = Number(toolArguments.k);
    const k = requestedK === 0 || Number.isNaN(requestedK) ? 8 : requestedK;
    const hits = await search(optionalString(toolArguments.query) ?? '', k, {
        type: optionalString(toolArguments.type),
        topic: optionalString(toolArguments.topic),
    });
    return jsonResult(hits);
}

function getTool(toolArguments: ToolArguments): CallToolResult {
    const id = optionalString(toolArguments.id) ?? '';
    const filePath = resolvePath(id);
    if (!filePath) {
        return jsonResult({ error: `unknown id: ${id}` });
    }
    return jsonResult({ id, path: filePath, content: readFileSync(filePath, 'utf8') });
}

async function writeTool(toolArguments: ToolArguments): Promise<CallToolResult> {
    const kind = optionalString(toolArguments.kind) ?? '';
    if (kind !== 'state' && kind !== 'log') {
        return jsonResult({ error: 'kind must be "state" or "log"' });
    }
    return jsonResult(
        await writeMemory({
            topic: optionalString(toolArguments.topic) ?? '',
            kind,
            content: optionalString(toolArguments.content) ?? '',
            slug: optionalString(toolArguments.slug),
        }),
    );
}

async function dispatch(request: CallToolRequest): Promise<CallToolResult> {
    const toolArguments: ToolArguments = request.params.arguments ?? {};
    switch (request.params.name) {
        case 'memory_search': {
            return await searchTool(toolArguments);
        }
        case 'memory_get': {
            return getTool(toolArguments);
        }
        case 'memory_write': {
            return await writeTool(toolArguments);
        }
        case 'memory_reindex': {
            return jsonResult(await reindex());
        }
        default: {
            return jsonResult({ error: `unknown tool: ${request.params.name}` });
        }
    }
}

async function handleCall(request: CallToolRequest): Promise<CallToolResult> {
    try {
        return await dispatch(request);
    } catch (error) {
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
            isError: true,
        };
    }
}

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    state.pending += 1;
    try {
        return await handleCall(request);
    } finally {
        state.pending -= 1;
        setImmediate(exitWhenDrained);
    }
});

await server.connect(new StdioServerTransport());
