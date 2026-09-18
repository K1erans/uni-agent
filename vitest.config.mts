import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          // src/test holds extension-host tests, run by @vscode/test-cli.
          exclude: ['src/test/**'],
          environment: 'node',
        },
      },
      {
        // Lit and @lit/react ship Node builds that skip client-side property updates, so resolve
        // (and inline, so Vite does the resolving) their browser builds instead.
        resolve: { conditions: ['browser'] },
        test: {
          name: 'webview',
          include: ['webview/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['webview/test/setup.ts'],
          server: {
            deps: { inline: [/node_modules\/(lit|lit-html|lit-element|@lit\/[^/]+|@vscode-elements\/[^/]+)\//] },
          },
        },
      },
    ],
  },
});
