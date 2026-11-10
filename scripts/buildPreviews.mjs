// Link previews (WhatsApp, Telegram, Facebook, …). Chat apps build a preview from a page's Open Graph tags and do
// not run JavaScript, and every artwork shares one page (index.html?seq=…), so each artwork gets:
//   previews/<id>.jpg      its finished artwork, 1200×630, the circle centred on the viewer's background
//   a/<id>/index.html      a share page whose tags name that image; it forwards visitors to ?seq=<id> at once
// plus previews/site.jpg (the newest artwork) for index.html's own tags. Written to public/ and docs/ (Pages serves
// docs/ and a build recreates docs/ from public/), skipping artworks whose zip has not changed since the last run
// (previews/index.json), and removing the files of artworks no longer in the gallery. Run by the build and by the
// GitHub Action on every push, so publishing from Peel Studio and deleting from the site need nothing else.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { strFromU8, unzipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = (process.env.SITE_URL ?? "https://ofirgaash1.github.io/thread-sequence-viewer/").replace(/\/?$/, "/");
const OUTPUT_ROOTS = ["public", "docs"].map((folder) => path.join(root, folder));
const WIDTH = 1200;
const HEIGHT = 630;
const SUPERSAMPLE = 2;
const MARGIN = 14;
const BACKGROUND = "#05070a";
const JPEG_QUALITY = 86;

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeIfChanged(file, data) {
  try {
    if (Buffer.compare(fs.readFileSync(file), Buffer.from(data)) === 0) return false;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return true;
}

function readSequence(zipFile) {
  const entries = unzipSync(fs.readFileSync(zipFile));
  const name = Object.keys(entries).filter((entry) => entry.toLowerCase().endsWith(".json")).sort()[0];
  if (!name) throw new Error(`${path.basename(zipFile)} has no .json`);
  return JSON.parse(strFromU8(entries[name]));
}

/** The finished artwork, drawn as the viewer draws it: every thread in order, transports included. */
function renderPreview(sequence) {
  const instructions = [...sequence.instructions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let nailCount = sequence.nailCount;
  if (!nailCount) {
    nailCount = 1;
    for (const item of instructions) {
      if (item.type !== "cut") nailCount = Math.max(nailCount, item.nailA + 1, item.nailB + 1);
    }
  }
  const colors = new Map((sequence.palette ?? []).map((entry) => [entry.name, `rgb(${entry.rgb.join(",")})`]));

  const width = WIDTH * SUPERSAMPLE;
  const height = HEIGHT * SUPERSAMPLE;
  const radius = (HEIGHT / 2 - MARGIN) * SUPERSAMPLE;
  const cx = width / 2;
  const cy = height / 2;
  const nails = Array.from({ length: nailCount }, (_, nail) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * nail) / nailCount;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
  const ratio = sequence.ratio > 0 ? sequence.ratio : 2000; // circle diameter / thread width

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  ctx.lineWidth = Math.max(0.5, (2 * radius) / ratio);
  ctx.lineCap = "round";

  let color = null;
  const flush = () => {
    if (color !== null) ctx.stroke();
  };
  for (const item of instructions) {
    if (item.type === "cut") continue;
    const a = nails[item.nailA];
    const b = nails[item.nailB];
    if (!a || !b) continue;
    const next = colors.get(item.color) ?? "#888";
    if (next !== color) {
      flush();
      color = next;
      ctx.strokeStyle = color;
      ctx.beginPath();
    }
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
  }
  flush();

  ctx.strokeStyle = "#5b6475";
  ctx.lineWidth = SUPERSAMPLE;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  const out = createCanvas(WIDTH, HEIGHT);
  const outCtx = out.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(canvas, 0, 0, WIDTH, HEIGHT);
  return out.encodeSync("jpeg", JPEG_QUALITY);
}

function displayTitle(entry) {
  return entry.group && entry.shortLabel ? `${entry.group} · ${entry.shortLabel}` : entry.label || entry.id;
}

function sharePage(entry, version) {
  const title = displayTitle(entry);
  const viewer = `../../?seq=${encodeURIComponent(entry.id)}`;
  const pageUrl = `${SITE}a/${encodeURIComponent(entry.id)}/`;
  const image = `${SITE}previews/${encodeURIComponent(entry.id)}.jpg?v=${version}`;
  const description = "String art, built thread by thread. Watch it come together.";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)} · String art</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="String art" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(pageUrl)}" />
    <meta property="og:image" content="${escapeHtml(image)}" />
    <meta property="og:image:type" content="image/jpeg" />
    <meta property="og:image:width" content="${WIDTH}" />
    <meta property="og:image:height" content="${HEIGHT}" />
    <meta property="og:image:alt" content="${escapeHtml(title)}, string art" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="canonical" href="${escapeHtml(pageUrl)}" />
    <meta http-equiv="refresh" content="0; url=${escapeHtml(viewer)}" />
    <script>location.replace(${JSON.stringify(viewer)} + location.hash);</script>
  </head>
  <body style="background: ${BACKGROUND}; color: #eef1f6; font-family: system-ui, sans-serif">
    <p><a href="${escapeHtml(viewer)}" style="color: #e6b877">Open ${escapeHtml(title)}</a></p>
  </body>
</html>
`;
}

export function buildPreviews({ log = console.log } = {}) {
  const sequencesDir = path.join(root, "public", "sequences");
  const manifest = readJson(path.join(sequencesDir, "manifest.json"), { sequences: [] });
  const entries = (manifest.sequences ?? []).filter(
    (entry) => entry && typeof entry.id === "string" && /^[a-z0-9-]+$/.test(entry.id) && typeof entry.file === "string",
  );
  const indexFile = path.join(root, "public", "previews", "index.json");
  const previousIndex = readJson(indexFile, {});
  const index = {};
  let changed = 0;

  for (const entry of entries) {
    const zipFile = path.join(sequencesDir, entry.file);
    if (!fs.existsSync(zipFile)) continue;
    const hash = crypto.createHash("sha256").update(fs.readFileSync(zipFile)).digest("hex").slice(0, 12);
    index[entry.id] = hash;
    const imageName = `${entry.id}.jpg`;
    const haveAll = OUTPUT_ROOTS.every((outRoot) => fs.existsSync(path.join(outRoot, "previews", imageName)));
    let image = null;
    if (previousIndex[entry.id] !== hash || !haveAll) {
      log(`Rendering ${entry.id}`);
      image = renderPreview(readSequence(zipFile));
    }
    for (const outRoot of OUTPUT_ROOTS) {
      if (image && writeIfChanged(path.join(outRoot, "previews", imageName), image)) changed++;
      if (writeIfChanged(path.join(outRoot, "a", entry.id, "index.html"), sharePage(entry, hash))) changed++;
    }
  }

  // index.html's own preview: the newest artwork.
  const newest = entries.find((entry) => index[entry.id]);
  if (newest) {
    const source = path.join(root, "public", "previews", `${newest.id}.jpg`);
    for (const outRoot of OUTPUT_ROOTS) {
      if (writeIfChanged(path.join(outRoot, "previews", "site.jpg"), fs.readFileSync(source))) changed++;
    }
  }

  // Artworks deleted from the gallery lose their image and share page.
  const keep = new Set(Object.keys(index));
  for (const outRoot of OUTPUT_ROOTS) {
    for (const name of fs.existsSync(path.join(outRoot, "previews")) ? fs.readdirSync(path.join(outRoot, "previews")) : []) {
      if (name.endsWith(".jpg") && name !== "site.jpg" && !keep.has(name.slice(0, -4))) {
        fs.rmSync(path.join(outRoot, "previews", name));
        changed++;
      }
    }
    for (const name of fs.existsSync(path.join(outRoot, "a")) ? fs.readdirSync(path.join(outRoot, "a")) : []) {
      if (!keep.has(name)) {
        fs.rmSync(path.join(outRoot, "a", name), { recursive: true, force: true });
        changed++;
      }
    }
  }

  const indexText = `${JSON.stringify(index, null, 2)}\n`;
  for (const outRoot of OUTPUT_ROOTS) {
    if (writeIfChanged(path.join(outRoot, "previews", "index.json"), indexText)) changed++;
  }
  log(`Previews: ${entries.length} artwork(s), ${changed} file(s) updated`);
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildPreviews();
