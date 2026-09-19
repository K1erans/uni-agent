import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // Pin to the minimum supported version (engines.vscode) so the node:sqlite floor stays verified.
  version: '1.106.0',
  mocha: { ui: 'tdd', timeout: 20_000 },
});
