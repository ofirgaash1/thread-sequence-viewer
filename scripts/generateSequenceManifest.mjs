// public/sequences/manifest.json is the gallery: the viewer reads it at runtime, Peel Studio's Publish adds to it,
// and the site's delete button removes from it (and from docs/sequences/manifest.json) through the GitHub API.
// This script keeps it in step with the zips in public/sequences: entries whose zip is gone are dropped and zips
// that are not listed yet are added at the end, so dropping a zip into the folder and rebuilding still works.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sequencesRoot = path.join(root, "public", "sequences");
const manifestFile = path.join(sequencesRoot, "manifest.json");

/** Order for zips added to the manifest in one go (later edits to the manifest's order are kept). */
const sequenceOrder = [
  "mona-641-404",
  "final-642",
  "seed-764",
  "new-mona-lisa",
  "mona-lisa",
  "duck",
  "ofir",
];

/** Gallery groups for zips added here: artworks of one subject are listed under the group name, each by its
 * short label. Untagged artworks with "Mona" in their name join the Mona Lisa group in the viewer. */
const sequenceGroups = {
  "mona-641-404": { group: "Mona Lisa", shortLabel: "641.404" },
  "final-642": { group: "Mona Lisa", shortLabel: "Final 642" },
  "seed-764": { group: "Mona Lisa", shortLabel: "Seed 764" },
  "new-mona-lisa": { group: "Mona Lisa", shortLabel: "New" },
  "mona-lisa": { group: "Mona Lisa", shortLabel: "Original" },
};

function humanizeZipName(filename) {
  const base = filename.replace(/\.zip$/i, "");
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function zipFilenameToId(filename) {
  return filename
    .replace(/\.zip$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function orderRank(id) {
  const index = sequenceOrder.indexOf(id);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function listSequenceZipFiles() {
  fs.mkdirSync(sequencesRoot, { recursive: true });
  return fs
    .readdirSync(sequencesRoot)
    .filter((name) => name.toLowerCase().endsWith(".zip"))
    .sort((a, b) => {
      const rank = orderRank(zipFilenameToId(a)) - orderRank(zipFilenameToId(b));
      return rank || a.localeCompare(b, undefined, { sensitivity: "base" });
    });
}

/** GitHub Pages is case-sensitive: zips are served under lowercase names. */
function sequenceZipUrlName(filename) {
  return filename.toLowerCase();
}

export function copySequenceZipsTo(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of listSequenceZipFiles()) {
    fs.copyFileSync(
      path.join(sequencesRoot, file),
      path.join(outDir, sequenceZipUrlName(file)),
    );
  }
}

export function generateSequenceManifest() {
  let manifest = { sequences: [] };
  let before = "";
  try {
    before = fs.readFileSync(manifestFile, "utf8");
    manifest = JSON.parse(before);
  } catch {}

  const zips = listSequenceZipFiles();
  const served = new Set(zips.map(sequenceZipUrlName));
  const sequences = (manifest.sequences ?? []).filter((entry) => served.has(String(entry.file).toLowerCase()));
  const listed = new Set(sequences.map((entry) => String(entry.file).toLowerCase()));
  for (const file of zips) {
    if (listed.has(sequenceZipUrlName(file))) continue;
    const id = zipFilenameToId(file);
    sequences.push({
      id,
      label: humanizeZipName(file),
      file: sequenceZipUrlName(file),
      ...sequenceGroups[id],
    });
  }

  const after = `${JSON.stringify({ ...manifest, sequences }, null, 2)}\n`;
  if (after !== before) fs.writeFileSync(manifestFile, after);
  return sequences;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sequences = generateSequenceManifest();
  console.log(`public/sequences/manifest.json lists ${sequences.length} artwork(s)`);
}
