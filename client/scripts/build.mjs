import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, '../public');
mkdirSync(outDir, { recursive: true });

const watch = process.argv.includes('--watch');

const shared = {
  entryPoints: [resolve(root, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2022', 'safari15', 'chrome90', 'firefox95'],
  outfile: resolve(outDir, 'app.js'),
  sourcemap: true,
  logLevel: 'info',
};

let ctx;
if (watch) {
  ctx = await context({ ...shared, minify: false });
  await ctx.watch();
  console.log('watching client/src…');
} else {
  await build({ ...shared, minify: true });
}

for (const f of ['index.html', 'style.css']) {
  copyFileSync(resolve(root, f), resolve(outDir, f));
}

await ctx?.dispose();