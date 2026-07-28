import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 8765,
  },
  build: {
    outDir: "dist",
  },
});
