import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist/embedded',
    target: 'es2022',
    assetsInlineLimit: 10 * 1024 * 1024,
    chunkSizeWarningLimit: 1800,
  },
  // Classic inline workers also run in opaque-origin MCP Apps sandboxes.
  worker: {
    format: 'iife',
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        // The MCP server serves the larger parser workers on demand.
        entryFileNames: '[name].js',
      },
    },
  },
});
