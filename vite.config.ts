import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  build: {
    outDir: path.resolve(__dirname, "dist-ui"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "./mcp-app.html"),
    },
  },
  plugins: [viteSingleFile()],
});
