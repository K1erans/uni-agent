import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          // src/test holds extension-host tests, run by @vscode/test-cli; live tests drive real CLIs.
          exclude: ['src/test/**', 'src/**/*.live.test.ts'],
          environment: 'node',
        },
      },
      {
        // Opt-in only (`npm run test:live`): runs the user's installed agent CLIs and re-records the
        // golden fixtures, so upstream changes show up as a fixture diff.
        test: {
          name: 'live',
          include: ['src/**/*.live.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
        },
      },
      {
        // Lit and @lit/react ship Node builds that skip client-side property updates, so resolve
        // (and inline, so Vite does the resolving) their browser builds instead.
        resolve: { conditions: ['browser'] },
        test: {
          name: 'webview',
          include: ['webview/**/*.test.{ts,tsx}'],
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
