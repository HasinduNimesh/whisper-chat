import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// One self-contained IIFE, no dependencies, no React — the loader must stay
// tiny (a few KB) because every store page pays for it. The chat UI itself
// lives in the iframe app (client/widget.html), not here.
export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(here, 'src/embed.ts'),
      name: 'WhisperChat',
      formats: ['iife'],
      fileName: () => 'embed.js',
    },
    minify: true,
  },
  test: {
    environment: 'jsdom',
  },
});
