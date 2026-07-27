// Flat ESLint config: type-aware TypeScript rules plus unicorn, with Prettier last.
import { defineConfig, globalIgnores } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import unicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';

export default defineConfig([
    globalIgnores(['node_modules/', '**/.mdmem/']),
    {
        files: ['**/*.ts'],
        plugins: { unicorn },
        extends: [
            tseslint.configs.strictTypeChecked,
            tseslint.configs.stylisticTypeChecked,
            'unicorn/all',
            eslintConfigPrettier,
        ],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // Every branch and loop body is a block, so single-line bodies cannot hide control flow.
            curly: ['error', 'all'],
            // Caps that keep functions readable: split rather than raise these.
            complexity: ['error', { max: 15 }],
            'max-depth': ['error', 4],
            'max-params': ['error', 5],
            // SQLite columns and JSON tool output use null as a real value; undefined is not interchangeable here.
            'unicorn/no-null': 'off',
            // The indexer and the MCP server are CLI entrypoints and must set an exit code.
            'unicorn/no-process-exit': 'off',
            // Temporal is behind a V8 flag on Node 24 and absent from the es2023 lib; Date stays.
            'unicorn/prefer-temporal': 'off',
        },
    },
    {
        // The high-level McpServer replacement only accepts Zod input schemas, which would add a runtime dependency.
        files: ['src/server.ts'],
        rules: { '@typescript-eslint/no-deprecated': 'off' },
    },
]);
