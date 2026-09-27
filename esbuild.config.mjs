import esbuild from 'esbuild';
import process from 'process';
import fs from 'fs';

const isProd = process.argv[2] === 'production';

const banner = `/* Whisper MCP v0.1.0 */`;

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  platform: 'node',
  target: 'es2018',
  sourcemap: isProd ? false : 'inline',
  logLevel: 'info',
  outfile: 'main.js'
});

if (isProd) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log('Watching for changes...');
}
