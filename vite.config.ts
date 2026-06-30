import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  copySequenceZipsTo,
  generateSequenceManifest,
  sequencesRoot,
} from "./scripts/generateSequenceManifest.mjs";

function sequencesManifestPlugin(): Plugin {
  const regenerate = () => generateSequenceManifest();

  return {
    name: "sequences-manifest",
    buildStart: regenerate,
    closeBundle() {
      copySequenceZipsTo(path.resolve("docs", "sequences"));
    },
    configureServer(server) {
      regenerate();
      server.watcher.add(sequencesRoot);
      const onZipChange = (file: string) => {
        if (
          file.startsWith(sequencesRoot) &&
          file.toLowerCase().endsWith(".zip")
        ) {
          regenerate();
        }
      };
      server.watcher.on("add", onZipChange);
      server.watcher.on("unlink", onZipChange);
    },
  };
}

export default defineConfig({
  base: "/thread-sequence-viewer/",
  build: {
    outDir: "docs",
  },
  plugins: [sequencesManifestPlugin(), react()],
});
