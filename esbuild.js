const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Reports esbuild problems in a format the VS Code problem matcher understands. */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

async function main() {
  const contexts = await Promise.all([
    // Extension host (Node).
    esbuild.context({
      ...shared,
      entryPoints: ['src/extension.ts'],
      format: 'cjs',
      platform: 'node',
      outfile: 'dist/extension.js',
      external: ['vscode'],
      // The Agent SDK is ESM and calls createRequire(import.meta.url) at load time, which a CJS
      // bundle leaves undefined; point it at the bundle itself.
      define: { 'import.meta.url': 'importMetaUrl' },
      banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
    }),
    // Thread webview (browser): emits dist/webview/main.js and main.css.
    esbuild.context({
      ...shared,
      entryPoints: ['webview/src/main.tsx'],
      format: 'iife',
      platform: 'browser',
      outdir: 'dist/webview',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
