import fs from "node:fs";
import assert from "node:assert/strict";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";

// Build bundles store discovery order top-first; the construction CSV gives
// the bottom-to-top order needed by the viewer's painter-order renderer.
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node scripts/convertBuildExport.mjs input.zip output.zip");
const entries = unzipSync(fs.readFileSync(input));
const find = (suffix) => {
  const name = Object.keys(entries).find(name => name.endsWith(suffix));
  assert.ok(name, `Missing ${suffix}`);
  return entries[name];
};
const manifest = JSON.parse(strFromU8(find("build-export/manifest.json")));
const sequence = JSON.parse(strFromU8(find("build-export/sequence.json")));
const rows = strFromU8(find("build-sequence-bottom-to-top.csv")).trim().split(/\r?\n/);
assert.equal(rows.shift(), "build_step_bottom_to_top,top_first_discovery_index,chord_id,nail_a,nail_b,color_index,red,green,blue");
const instructions = rows.map((row, order) => {
  const [step, discovery, chord, nailA, nailB, color, r, g, b] = row.split(",").map(Number);
  assert.equal(step, order + 1);
  assert.ok(nailA >= 0 && nailA < sequence.nailCount && nailB >= 0 && nailB < sequence.nailCount);
  assert.deepEqual(sequence.palette[color], [r, g, b]);
  assert.equal(sequence.lines[discovery].chordId, chord);
  assert.equal(sequence.lines[discovery].color, color);
  assert.equal(sequence.chordNails[chord * 2], nailA);
  assert.equal(sequence.chordNails[chord * 2 + 1], nailB);
  return { order, type: "image", color: `Color ${color + 1}`, nailA, nailB };
});
assert.equal(instructions.length, manifest.csvRows);
assert.equal(instructions.length, sequence.lines.length);
const exportData = {
  nailCount: sequence.nailCount,
  ratio: sequence.resolution / sequence.lineWidthPx,
  safetyMode: "independent placements",
  palette: sequence.palette.map((rgb, index) => ({ name: `Color ${index + 1}`, rgb })),
  instructions,
};
fs.writeFileSync(output, zipSync({ "sequence.json": strToU8(JSON.stringify(exportData)) }, { level: 9 }));
console.log(`Converted ${input}: ${instructions.length} placements, ratio ${exportData.ratio}`);
