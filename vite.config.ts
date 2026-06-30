import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/thread-sequence-viewer/",
  build: {
    outDir: "docs",
  },
  plugins: [react()],
});
