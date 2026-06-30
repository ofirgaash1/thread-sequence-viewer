import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { generateSequenceManifest } from "./scripts/generateSequenceManifest.mjs";

const sequencesRoot = path.resolve("public", "sequences");

function sequencesManifestPlugin(): Plugin {
  const regenerate = () => generateSequenceManifest();

  return {
    name: "sequences-manifest",
    buildStart: regenerate,
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
