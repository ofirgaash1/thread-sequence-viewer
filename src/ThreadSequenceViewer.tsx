import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { strFromU8, unzipSync } from "fflate";
import { WebGLThreadRenderer } from "./WebGLThreadRenderer";
import { DeleteDialog } from "./DeleteDialog";
import { storedToken } from "./githubDelete";

type PhysicalDrawInstruction =
  | {
      order: number;
      type: "image" | "transport";
      color: string;
      nailA: number;
      nailB: number;
      hiddenByFutureLayers?: boolean;
      visibleSameColor?: boolean;
      sourceLineId?: number;
    }
  | {
      order: number;
      type: "cut";
      color: string;
      atNail?: number;
      reason?: string;
    };

type PhysicalSequenceExport = {
  safetyMode?: string;
  nailCount?: number;
  /** Circle diameter / thread width (peel: optimizationResolution / lineWidthPx). */
  ratio?: number;
  palette?: { name: string; rgb: [number, number, number] }[];
  audit?: {
    imageLineCount?: number;
    transportLineCount?: number;
    cutCount?: number;
    valid?: boolean;
  };
  instructions: PhysicalDrawInstruction[];
};

type SequenceOption = {
  id: string;
  label: string;
  /** Zip name in sequences/ (what deleting removes). */
  file: string;
  url: string;
  /** Gallery group (e.g. "Mona Lisa"); artworks sharing one are listed together. */
  group?: string;
  /** Name inside its group (e.g. "641.794"). */
  shortLabel?: string;
};

type GallerySection =
  | { kind: "single"; option: SequenceOption }
  | { kind: "group"; name: string; options: SequenceOption[] };

/** Where the panel sits: beside the circle (landscape), below it (portrait), or in a drawer over it (near-square). */
type LayoutMode = "side" | "bottom" | "overlay";

type ViewerLayout = {
  mode: LayoutMode;
  /** Circle centre and diameter in CSS px: the diameter is always the viewport's short side. */
  cx: number;
  cy: number;
  size: number;
  panel: { left: number; top: number; width: number; height: number } | null;
};

type ZoomTransform = { x: number; y: number; k: number };

type DrawCommand =
  | {
      type: "line";
      color: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      transport: boolean;
    }
  | {
      type: "cut";
      x: number;
      y: number;
    };

type SvgLineSegment = {
  segmentIndex: number;
  visibleStep: number;
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type SvgLineChunk = {
  key: number;
  color: string;
  startStep: number;
  endStep: number;
  fullD: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  segments: SvgLineSegment[];
};

type IndexedSvgLineSegment = SvgLineSegment & {
  chunkKey: number;
  color: string;
};

type SvgLineSpatialIndex = {
  cellSize: number;
  cols: number;
  rows: number;
  cells: number[][];
  segments: IndexedSvgLineSegment[];
};

type CanvasLineRenderState = {
  scene: ReturnType<typeof buildSvgScene>;
  step: number;
  renderKey: string;
};

type PinchState = {
  distance: number;
  midpointX: number;
  midpointY: number;
  transform: ZoomTransform;
  anchor: { x: number; y: number };
};

type CanvasMetrics = {
  cssWidth: number;
  cssHeight: number;
  width: number;
  height: number;
  dpr: number;
  scale: number;
  offsetX: number;
  offsetY: number;
};

type SvgCutCommand = {
  visibleStep: number;
  x: number;
  y: number;
};

type SceneRect = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const SVG_MIN = -15;
const SVG_SIZE = 30;
const SVG_MAX = SVG_MIN + SVG_SIZE;
const CENTER = 0;
const RADIUS = 10;
const FRAME_STROKE_WIDTH = 0.03125;
const NAIL_RADIUS = 0.033;
const SVG_SEGMENTS_PER_PATH = 1500;
const SPATIAL_INDEX_CELL_SIZE = 1;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 1000;
const CULL_ZOOM_THRESHOLD = 4;
const WHEEL_ZOOM_DENOMINATOR = 320;
const DEFAULT_DIAMETER_TO_THREAD_RATIO = 2000;
/** Scene units spanned by the viewport's short side: the frame and its nails touch the screen edges. */
const VIEW_EXTENT = 2 * RADIUS + 0.12;
const SIDE_PANEL_MIN = 240;
const SIDE_PANEL_MAX = 380;
const BOTTOM_PANEL_MIN = 200;

function computeLayout(width: number, height: number): ViewerLayout {
  const size = Math.min(width, height);
  if (width - height >= SIDE_PANEL_MIN) {
    const panelWidth = Math.min(SIDE_PANEL_MAX, width - height);
    return {
      mode: "side",
      size,
      cx: panelWidth + (width - panelWidth) / 2,
      cy: height / 2,
      panel: { left: 0, top: 0, width: panelWidth, height },
    };
  }
  if (height - width >= BOTTOM_PANEL_MIN) {
    return {
      mode: "bottom",
      size,
      cx: width / 2,
      cy: width / 2,
      panel: { left: 0, top: width, width, height: height - width },
    };
  }
  return { mode: "overlay", size, cx: width / 2, cy: height / 2, panel: null };
}

/** Untagged published artworks named after the Mona Lisa join that group. */
function inferGroup(label: string): { group?: string; shortLabel?: string } {
  if (!/\bmona\b/i.test(label)) return {};
  const shortLabel = label.replace(/^\s*(new\s+)?mona(\s+lisa)?\s*/i, (_, isNew) => (isNew ? "New " : "")).trim();
  return { group: "Mona Lisa", shortLabel: shortLabel || "Original" };
}

function buildGallerySections(options: SequenceOption[]): GallerySection[] {
  const sections: GallerySection[] = [];
  const groups = new Map<string, Extract<GallerySection, { kind: "group" }>>();
  for (const option of options) {
    if (!option.group) {
      sections.push({ kind: "single", option });
      continue;
    }
    let section = groups.get(option.group);
    if (!section) {
      section = { kind: "group", name: option.group, options: [] };
      groups.set(option.group, section);
      sections.push(section);
    }
    section.options.push(option);
  }
  return sections.map((section) =>
    section.kind === "group" && section.options.length === 1
      ? { kind: "single", option: { ...section.options[0]!, shortLabel: undefined } }
      : section,
  );
}
const REFERENCE_THREAD_WIDTH_MM = 1;

function isPhysicalSequenceExport(value: unknown): value is PhysicalSequenceExport {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { instructions?: unknown };
  return Array.isArray(maybe.instructions);
}

/** sequences/manifest.json: the gallery, in display order (Peel Studio adds new artworks at the top). It is read
 * at runtime, so publishing or deleting an artwork needs no rebuild. */
type ManifestEntry = { id: string; label: string; file: string; group?: string; shortLabel?: string };

function manifestEntryToOption(entry: ManifestEntry): SequenceOption {
  return {
    id: entry.id,
    label: entry.label,
    file: entry.file,
    url: `${import.meta.env.BASE_URL}sequences/${encodeURIComponent(entry.file)}`,
    ...(entry.group ? { group: entry.group, shortLabel: entry.shortLabel } : inferGroup(entry.label)),
  };
}

async function fetchGallery(): Promise<SequenceOption[]> {
  const response = await fetch(`${import.meta.env.BASE_URL}sequences/manifest.json`, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load the gallery (${response.status})`);
  const data = (await response.json()) as { sequences?: ManifestEntry[] };
  return (data.sequences ?? [])
    .filter((entry) => entry && typeof entry.id === "string" && typeof entry.file === "string")
    .map((entry) =>
      manifestEntryToOption({
        id: entry.id,
        label: entry.label || entry.id,
        file: entry.file,
        group: typeof entry.group === "string" ? entry.group : undefined,
        shortLabel: typeof entry.shortLabel === "string" ? entry.shortLabel : undefined,
      }),
    );
}

/** ?seq=<id>: open that artwork first (links from Peel Studio's Publish). */
function sequenceParam(): string | null {
  return new URLSearchParams(window.location.search).get("seq");
}

function ratioParam(): number | null {
  const value = new URLSearchParams(window.location.search).get("ratio");
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function lineWidthFromDiameterToThreadRatio(ratio: number): number {
  const safeRatio = Math.max(1, ratio);
  return Math.max(
    0.001,
    (RADIUS * 2 * REFERENCE_THREAD_WIDTH_MM) / safeRatio,
  );
}

function parsePhysicalSequenceJson(text: string): PhysicalSequenceExport {
  const parsed = JSON.parse(text) as unknown;
  if (!isPhysicalSequenceExport(parsed)) {
    throw new Error("Sequence does not contain an instructions array");
  }
  const ordered = [...parsed.instructions].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  return { ...parsed, instructions: ordered };
}

function readZipJson(bytes: Uint8Array): {
  text: string;
  displayName: string;
} {
  const entries = unzipSync(bytes);
  const jsonEntryName = Object.keys(entries)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))[0];

  if (!jsonEntryName) {
    throw new Error("Zip file does not contain a .json file");
  }

  return {
    text: strFromU8(entries[jsonEntryName]!),
    displayName: jsonEntryName,
  };
}

const loadedSequences = new Map<string, Promise<{
  sequence: PhysicalSequenceExport;
  displayName: string;
}>>();

function loadPhysicalSequence(option: SequenceOption) {
  let pending = loadedSequences.get(option.url);
  if (!pending) {
    pending = fetchPhysicalSequence(option).catch((error) => {
      loadedSequences.delete(option.url);
      throw error;
    });
    loadedSequences.set(option.url, pending);
  }
  return pending;
}

async function fetchPhysicalSequence(option: SequenceOption): Promise<{
  sequence: PhysicalSequenceExport;
  displayName: string;
}> {
  const response = await fetch(option.url);
  if (!response.ok) {
    throw new Error(`Could not load ${option.label} (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    option.url.toLowerCase().endsWith(".zip") &&
    (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
  ) {
    throw new Error(
      `Could not load ${option.label}: zip file missing from deployment`,
    );
  }
  const loaded = option.url.toLowerCase().endsWith(".zip")
    ? readZipJson(bytes)
    : {
        text: new TextDecoder().decode(bytes),
        displayName: option.url.split("/").pop() ?? option.label,
      };
  return {
    sequence: parsePhysicalSequenceJson(loaded.text),
    displayName: loaded.displayName,
  };
}

function hashColor(name: string): string {
  const fixed: Record<string, string> = {
    black: "#111111",
    white: "#f5f5f5",
    red: "#dc2828",
    blue: "#285adc",
    yellow: "#f0dc32",
    green: "#28a046",
  };
  if (fixed[name]) return fixed[name];
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 72% 58%)`;
}

function rgbCss(rgb: [number, number, number]): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function nailPoint(nail: number, nailCount: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (2 * Math.PI * nail) / nailCount;
  return {
    x: CENTER + RADIUS * Math.cos(angle),
    y: CENTER + RADIUS * Math.sin(angle),
  };
}

function inferNailCount(instructions: PhysicalDrawInstruction[]): number {
  let maxNail = 0;
  for (const instr of instructions) {
    if (instr.type === "cut") {
      if (instr.atNail !== undefined) maxNail = Math.max(maxNail, instr.atNail);
      continue;
    }
    maxNail = Math.max(maxNail, instr.nailA, instr.nailB);
  }
  return maxNail + 1;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function fullSceneRect(): SceneRect {
  return {
    minX: SVG_MIN,
    minY: SVG_MIN,
    maxX: SVG_MAX,
    maxY: SVG_MAX,
  };
}

function visibleSceneRect(transform: ZoomTransform, metrics: CanvasMetrics): SceneRect {
  if (transform.k < CULL_ZOOM_THRESHOLD) return fullSceneRect();
  const toSceneX = (px: number) =>
    ((px - metrics.offsetX) / metrics.scale + SVG_MIN - transform.x) / transform.k;
  const toSceneY = (px: number) =>
    ((px - metrics.offsetY) / metrics.scale + SVG_MIN - transform.y) / transform.k;
  const minX = toSceneX(0);
  const minY = toSceneY(0);
  const maxX = toSceneX(metrics.width);
  const maxY = toSceneY(metrics.height);
  const overscan = Math.max(0.16, Math.max(maxX - minX, maxY - minY) * 0.75);
  return {
    minX: minX - overscan,
    minY: minY - overscan,
    maxX: maxX + overscan,
    maxY: maxY + overscan,
  };
}

function boundsOverlap(
  a: SceneRect,
  b: SceneRect,
  padding = 0,
): boolean {
  return (
    a.maxX + padding >= b.minX &&
    a.minX - padding <= b.maxX &&
    a.maxY + padding >= b.minY &&
    a.minY - padding <= b.maxY
  );
}

function expandedRect(rect: SceneRect, padding: number): SceneRect {
  return {
    minX: rect.minX - padding,
    minY: rect.minY - padding,
    maxX: rect.maxX + padding,
    maxY: rect.maxY + padding,
  };
}

function svgNumber(n: number): string {
  return Number(n.toFixed(3)).toString();
}

function lineSegmentPath(
  line: { x1: number; y1: number; x2: number; y2: number },
): string {
  return `M${svgNumber(line.x1)} ${svgNumber(line.y1)}L${svgNumber(
    line.x2,
  )} ${svgNumber(line.y2)}`;
}

function sceneCell(
  value: number,
  cellSize: number,
  maxCell: number,
): number {
  return clamp(Math.floor((value - SVG_MIN) / cellSize), 0, maxCell);
}

function addLineCells(
  cells: number[][],
  cols: number,
  rows: number,
  cellSize: number,
  segment: SvgLineSegment,
): void {
  let cellX = sceneCell(segment.x1, cellSize, cols - 1);
  let cellY = sceneCell(segment.y1, cellSize, rows - 1);
  const endX = sceneCell(segment.x2, cellSize, cols - 1);
  const endY = sceneCell(segment.y2, cellSize, rows - 1);
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const nextBoundaryX =
    SVG_MIN + (cellX + (stepX > 0 ? 1 : 0)) * cellSize;
  const nextBoundaryY =
    SVG_MIN + (cellY + (stepY > 0 ? 1 : 0)) * cellSize;
  let tMaxX = stepX === 0 ? Infinity : (nextBoundaryX - segment.x1) / dx;
  let tMaxY = stepY === 0 ? Infinity : (nextBoundaryY - segment.y1) / dy;
  const tDeltaX = stepX === 0 ? Infinity : cellSize / Math.abs(dx);
  const tDeltaY = stepY === 0 ? Infinity : cellSize / Math.abs(dy);
  const maxSteps = cols + rows + 2;

  for (let i = 0; i < maxSteps; i++) {
    cells[cellY * cols + cellX]!.push(segment.segmentIndex);
    if (cellX === endX && cellY === endY) break;
    if (tMaxX < tMaxY) {
      cellX = clamp(cellX + stepX, 0, cols - 1);
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxX) {
      cellY = clamp(cellY + stepY, 0, rows - 1);
      tMaxY += tDeltaY;
    } else {
      cellX = clamp(cellX + stepX, 0, cols - 1);
      cellY = clamp(cellY + stepY, 0, rows - 1);
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    }
  }
}

function buildLineSpatialIndex(chunks: SvgLineChunk[]): SvgLineSpatialIndex {
  const cellSize = SPATIAL_INDEX_CELL_SIZE;
  const cols = Math.ceil(SVG_SIZE / cellSize);
  const rows = Math.ceil(SVG_SIZE / cellSize);
  const cells = Array.from({ length: cols * rows }, () => [] as number[]);
  const segments: IndexedSvgLineSegment[] = [];

  for (const chunk of chunks) {
    for (const segment of chunk.segments) {
      segments[segment.segmentIndex] = {
        ...segment,
        chunkKey: chunk.key,
        color: chunk.color,
      };
      addLineCells(cells, cols, rows, cellSize, segment);
    }
  }

  return { cellSize, cols, rows, cells, segments };
}

function queryLineSpatialIndex(
  index: SvgLineSpatialIndex,
  rect: SceneRect,
): IndexedSvgLineSegment[] {
  const minX = sceneCell(rect.minX, index.cellSize, index.cols - 1);
  const maxX = sceneCell(rect.maxX, index.cellSize, index.cols - 1);
  const minY = sceneCell(rect.minY, index.cellSize, index.rows - 1);
  const maxY = sceneCell(rect.maxY, index.cellSize, index.rows - 1);
  const segmentIds = new Set<number>();

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      for (const segmentIndex of index.cells[y * index.cols + x]!) {
        segmentIds.add(segmentIndex);
      }
    }
  }

  return [...segmentIds]
    .sort((a, b) => a - b)
    .map((segmentIndex) => index.segments[segmentIndex]!)
    .filter(Boolean);
}

function buildOrderedSvgScene(commands: (DrawCommand | null)[]): {
  lineChunks: SvgLineChunk[];
  cuts: SvgCutCommand[];
  lineIndex: SvgLineSpatialIndex;
} {
  const lineChunks: SvgLineChunk[] = [];
  const cuts: SvgCutCommand[] = [];
  let nextSegmentIndex = 0;
  let current:
    | {
        color: string;
        segments: SvgLineSegment[];
      }
    | null = null;

  const flush = () => {
    if (!current || current.segments.length === 0) {
      current = null;
      return;
    }
    lineChunks.push({
      key: lineChunks.length,
      color: current.color,
      startStep: current.segments[0]!.visibleStep,
      endStep: current.segments[current.segments.length - 1]!.visibleStep,
      fullD: current.segments.map((segment) => segment.d).join(""),
      minX: Math.min(...current.segments.map((segment) => segment.minX)),
      minY: Math.min(...current.segments.map((segment) => segment.minY)),
      maxX: Math.max(...current.segments.map((segment) => segment.maxX)),
      maxY: Math.max(...current.segments.map((segment) => segment.maxY)),
      segments: current.segments,
    });
    current = null;
  };

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    if (!command) {
      flush();
      continue;
    }

    if (command.type === "cut") {
      flush();
      cuts.push({
        visibleStep: i + 1,
        x: command.x,
        y: command.y,
      });
      continue;
    }

    if (
      !current ||
      current.color !== command.color ||
      current.segments.length >= SVG_SEGMENTS_PER_PATH
    ) {
      flush();
      current = {
        color: command.color,
        segments: [],
      };
    }
    current.segments.push({
      segmentIndex: nextSegmentIndex++,
      visibleStep: i + 1,
      d: lineSegmentPath(command),
      x1: command.x1,
      y1: command.y1,
      x2: command.x2,
      y2: command.y2,
      minX: Math.min(command.x1, command.x2),
      minY: Math.min(command.y1, command.y2),
      maxX: Math.max(command.x1, command.x2),
      maxY: Math.max(command.y1, command.y2),
    });
  }
  flush();

  return { lineChunks, cuts, lineIndex: buildLineSpatialIndex(lineChunks) };
}

function buildSvgScene(commands: (DrawCommand | null)[]): {
  lineChunks: SvgLineChunk[];
  cuts: SvgCutCommand[];
  lineIndex: SvgLineSpatialIndex;
} {
  return buildOrderedSvgScene(commands);
}

function firstSegmentAfterStep(
  segments: IndexedSvgLineSegment[],
  step: number,
): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (segments[mid]!.visibleStep <= step) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function resizeCanvasToDisplay(canvas: HTMLCanvasElement): CanvasMetrics | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const layout = computeLayout(rect.width, rect.height);
  const scale = (layout.size * dpr) / VIEW_EXTENT;
  return {
    cssWidth: rect.width,
    cssHeight: rect.height,
    width,
    height,
    dpr,
    scale,
    offsetX: layout.cx * dpr + SVG_MIN * scale,
    offsetY: layout.cy * dpr + SVG_MIN * scale,
  };
}

function canvasRenderKey(
  metrics: CanvasMetrics,
  transform: ZoomTransform,
  lineWidth: number,
  lineOpacity: number,
): string {
  return [
    metrics.width,
    metrics.height,
    svgNumber(transform.x),
    svgNumber(transform.y),
    svgNumber(transform.k),
    Number(lineWidth.toFixed(4)).toString(),
    Number(lineOpacity.toFixed(3)).toString(),
  ].join(":");
}

function sceneToCanvas(
  metrics: CanvasMetrics,
  transform: ZoomTransform,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: metrics.offsetX + (x * transform.k + transform.x - SVG_MIN) * metrics.scale,
    y: metrics.offsetY + (y * transform.k + transform.y - SVG_MIN) * metrics.scale,
  };
}

function clientPointToCanvasScene(
  canvas: HTMLCanvasElement,
  transform: ZoomTransform,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const layout = computeLayout(rect.width, rect.height);
  const scale = layout.size / VIEW_EXTENT;
  const offsetX = layout.cx + SVG_MIN * scale;
  const offsetY = layout.cy + SVG_MIN * scale;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  return {
    x: ((x - offsetX) / scale + SVG_MIN - transform.x) / transform.k,
    y: ((y - offsetY) / scale + SVG_MIN - transform.y) / transform.k,
  };
}

function clearCanvas(ctx: CanvasRenderingContext2D, metrics: CanvasMetrics): void {
  ctx.clearRect(0, 0, metrics.width, metrics.height);
}

function drawCanvasLineRange(
  ctx: CanvasRenderingContext2D,
  metrics: CanvasMetrics,
  scene: ReturnType<typeof buildSvgScene>,
  transform: ZoomTransform,
  fromStep: number,
  toStep: number,
  lineWidth: number,
  lineOpacity: number,
  cullRect: SceneRect | null,
): void {
  if (toStep <= fromStep || lineOpacity <= 0) return;
  const segments = scene.lineIndex.segments;
  const candidates = cullRect
    ? queryLineSpatialIndex(scene.lineIndex, expandedRect(cullRect, lineWidth * 4))
    : null;
  const start = candidates ? 0 : firstSegmentAfterStep(segments, fromStep);
  const drawSegments = candidates ?? segments;
  let currentColor = "";
  let hasPath = false;

  const flush = () => {
    if (!hasPath) return;
    ctx.stroke();
    hasPath = false;
  };

  ctx.save();
  ctx.globalAlpha = lineOpacity;
  ctx.lineWidth = Math.max(0.5, lineWidth * transform.k * metrics.scale);
  ctx.lineCap = "round";

  for (let i = start; i < drawSegments.length; i++) {
    const segment = drawSegments[i]!;
    if (segment.visibleStep <= fromStep) continue;
    if (segment.visibleStep > toStep) {
      if (!candidates) break;
      continue;
    }
    if (cullRect && !boundsOverlap(segment, cullRect, lineWidth * 4)) continue;
    if (segment.color !== currentColor) {
      flush();
      currentColor = segment.color;
      ctx.strokeStyle = currentColor;
      ctx.beginPath();
    }
    const a = sceneToCanvas(metrics, transform, segment.x1, segment.y1);
    const b = sceneToCanvas(metrics, transform, segment.x2, segment.y2);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    hasPath = true;
  }

  flush();
  ctx.restore();
}

function drawCanvasOverlay(
  canvas: HTMLCanvasElement,
  nailPoints: { x: number; y: number }[],
  transform: ZoomTransform,
): void {
  const metrics = resizeCanvasToDisplay(canvas);
  const ctx = canvas.getContext("2d");
  if (!metrics || !ctx) return;
  const cullRect =
    transform.k >= CULL_ZOOM_THRESHOLD ? visibleSceneRect(transform, metrics) : null;
  clearCanvas(ctx, metrics);

  ctx.save();
  ctx.lineWidth = Math.max(0.5, FRAME_STROKE_WIDTH * transform.k * metrics.scale);
  ctx.strokeStyle = "#5b6475";
  ctx.beginPath();
  const center = sceneToCanvas(metrics, transform, CENTER, CENTER);
  ctx.arc(center.x, center.y, RADIUS * transform.k * metrics.scale, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#7d8798";
  const nailRadius = Math.max(1, NAIL_RADIUS * transform.k * metrics.scale);
  for (const point of nailPoints) {
    if (
      cullRect &&
      !boundsOverlap(
        { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y },
        cullRect,
        NAIL_RADIUS * 4,
      )
    ) {
      continue;
    }
    const p = sceneToCanvas(metrics, transform, point.x, point.y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, nailRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function rebuildCanvasLines(
  canvas: HTMLCanvasElement,
  scene: ReturnType<typeof buildSvgScene>,
  step: number,
  transform: ZoomTransform,
  lineWidth: number,
  lineOpacity: number,
): string | null {
  const metrics = resizeCanvasToDisplay(canvas);
  // Prefer software rasterization: Chrome's accelerated thick-stroke path
  // stalls for seconds on dense exports at high device pixel ratios.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!metrics || !ctx) return null;
  const key = canvasRenderKey(metrics, transform, lineWidth, lineOpacity);
  const cullRect =
    transform.k >= CULL_ZOOM_THRESHOLD ? visibleSceneRect(transform, metrics) : null;
  clearCanvas(ctx, metrics);
  drawCanvasLineRange(
    ctx,
    metrics,
    scene,
    transform,
    0,
    step,
    lineWidth,
    lineOpacity,
    cullRect,
  );
  return key;
}

function appendCanvasLines(
  canvas: HTMLCanvasElement,
  scene: ReturnType<typeof buildSvgScene>,
  fromStep: number,
  toStep: number,
  transform: ZoomTransform,
  lineWidth: number,
  lineOpacity: number,
): string | null {
  const metrics = resizeCanvasToDisplay(canvas);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!metrics || !ctx) return null;
  const key = canvasRenderKey(metrics, transform, lineWidth, lineOpacity);
  const cullRect =
    transform.k >= CULL_ZOOM_THRESHOLD ? visibleSceneRect(transform, metrics) : null;
  drawCanvasLineRange(
    ctx,
    metrics,
    scene,
    transform,
    fromStep,
    toStep,
    lineWidth,
    lineOpacity,
    cullRect,
  );
  return key;
}

export function ThreadSequenceViewer() {
  const [sequence, setSequence] = useState<PhysicalSequenceExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playbackStep, setStep] = useState(0);
  const [finalsOnly, setFinalsOnly] = useState(false);
  const [drawTransports, setDrawTransports] = useState(true);
  const finalsOnlyRef = useRef(false);
  const sequenceLoadRef = useRef(0);
  const requestedSequenceRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [stepsPerSecond, setStepsPerSecond] = useState(3500);
  const [sequences, setSequences] = useState<SequenceOption[]>([]);
  const [galleryLoaded, setGalleryLoaded] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SequenceOption | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [activeSequenceId, setActiveSequenceId] = useState<string | null>(null);
  const initialSequenceLoadedRef = useRef(false);
  const [canvasResizeTick, setCanvasResizeTick] = useState(0);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const [cullTransform, setCullTransform] = useState<ZoomTransform>({
    x: 0,
    y: 0,
    k: 1,
  });
  const lineCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoomTransformRef = useRef<ZoomTransform>({ x: 0, y: 0, k: 1 });
  const renderFrameRef = useRef<number | null>(null);
  const canvasLineStateRef = useRef<CanvasLineRenderState | null>(null);
  const webglRendererRef = useRef<WebGLThreadRenderer | null | undefined>(undefined);
  const finalViewsRef = useRef(new Map<string, HTMLCanvasElement>());
  const sceneCacheRef = useRef(new WeakMap<PhysicalSequenceExport, Map<boolean, ReturnType<typeof buildSvgScene>>>());
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<PinchState | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    transform: ZoomTransform;
  } | null>(null);

  const layout = computeLayout(viewport.width, viewport.height);
  const gallerySections = useMemo(() => buildGallerySections(sequences), [sequences]);
  /** Gallery order (grouped artworks adjacent): what the arrow keys step through. */
  const galleryOrder = useMemo(
    () => gallerySections.flatMap((section) => (section.kind === "group" ? section.options : [section.option])),
    [gallerySections],
  );
  const activeOption = sequences.find((option) => option.id === activeSequenceId) ?? null;
  const zoomed = cullTransform.k !== 1 || cullTransform.x !== 0 || cullTransform.y !== 0;
  const instructions = sequence?.instructions ?? [];
  const nailCount = useMemo(
    () => sequence?.nailCount ?? inferNailCount(instructions),
    [instructions, sequence?.nailCount],
  );
  const colorByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of sequence?.palette ?? []) {
      map.set(entry.name, rgbCss(entry.rgb));
    }
    return map;
  }, [sequence?.palette]);
  const maxStep = instructions.length;
  const step = finalsOnly ? maxStep : playbackStep;
  const completed = maxStep > 0 && step >= maxStep;
  const diameterToThreadRatio = useMemo(() => {
    const urlRatio = ratioParam();
    if (urlRatio !== null) return urlRatio;
    if (sequence?.ratio !== undefined && sequence.ratio > 0) {
      return sequence.ratio;
    }
    return DEFAULT_DIAMETER_TO_THREAD_RATIO;
  }, [sequence?.ratio]);
  const lineWidth = useMemo(
    () => lineWidthFromDiameterToThreadRatio(diameterToThreadRatio),
    [diameterToThreadRatio],
  );
  const lineOpacity = 1;
  const drawCommands = useMemo<(DrawCommand | null)[]>(() => {
    if (nailCount <= 1) return instructions.map(() => null);
    return instructions.map((instr) => {
      if (instr.type === "transport" && !drawTransports) return null;
      if (instr.type === "cut") {
        if (instr.atNail === undefined) return null;
        const p = nailPoint(instr.atNail, nailCount);
        return { type: "cut", x: p.x, y: p.y };
      }

      const a = nailPoint(instr.nailA, nailCount);
      const b = nailPoint(instr.nailB, nailCount);
      return {
        type: "line",
        color: colorByName.get(instr.color) ?? hashColor(instr.color),
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        transport: instr.type === "transport",
      };
    });
  }, [colorByName, drawTransports, instructions, nailCount]);
  const svgScene = useMemo(() => {
    if (!sequence) return buildSvgScene(drawCommands);
    let variants = sceneCacheRef.current.get(sequence);
    if (!variants) {
      variants = new Map();
      sceneCacheRef.current.set(sequence, variants);
    }
    let scene = variants.get(drawTransports);
    if (!scene) {
      scene = buildSvgScene(drawCommands);
      variants.set(drawTransports, scene);
    }
    return scene;
  }, [drawCommands, drawTransports, sequence]);
  const nailPoints = useMemo(() => {
    if (nailCount <= 1) return [];
    return Array.from({ length: nailCount }, (_, nail) =>
      nailPoint(nail, nailCount),
    );
  }, [nailCount]);

  useLayoutEffect(() => () => {
    webglRendererRef.current?.dispose();
    webglRendererRef.current = undefined;
  }, []);

  useLayoutEffect(() => {
    const canvas = lineCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!canvas) return;

    const transform = zoomTransformRef.current;
    const previous = canvasLineStateRef.current;
    const metrics = resizeCanvasToDisplay(canvas);
    if (!metrics) return;
    if (webglRendererRef.current === undefined) {
      try { webglRendererRef.current = new WebGLThreadRenderer(canvas); }
      catch { webglRendererRef.current = null; }
    }
    if (webglRendererRef.current) {
      webglRendererRef.current.draw(svgScene, step, transform, lineWidth, metrics);
      if (overlayCanvas) drawCanvasOverlay(overlayCanvas, nailPoints, transform);
      return;
    }
    const renderKey = canvasRenderKey(metrics, transform, lineWidth, lineOpacity);
    const finalKey = `${activeSequenceId}:${drawTransports}:${renderKey}`;
    const cachedFinal = finalsOnly ? finalViewsRef.current.get(finalKey) : undefined;
    if (cachedFinal) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        clearCanvas(ctx, metrics);
        ctx.drawImage(cachedFinal, 0, 0);
        canvasLineStateRef.current = { scene: svgScene, step, renderKey };
        // Refresh insertion order so the least recently used view is evicted first.
        finalViewsRef.current.delete(finalKey);
        finalViewsRef.current.set(finalKey, cachedFinal);
        if (overlayCanvas) drawCanvasOverlay(overlayCanvas, nailPoints, transform);
        return;
      }
    }
    const cacheFinal = () => {
      if (!finalsOnly || !maxStep) return;
      const snapshot = document.createElement("canvas");
      snapshot.width = metrics.width;
      snapshot.height = metrics.height;
      const snapshotCtx = snapshot.getContext("2d", { willReadFrequently: true });
      if (!snapshotCtx) return;
      snapshotCtx.drawImage(canvas, 0, 0);
      finalViewsRef.current.set(finalKey, snapshot);
      // Three full-resolution views bound memory use while comparing artworks.
      if (finalViewsRef.current.size > 3) {
        const oldest = finalViewsRef.current.keys().next().value;
        if (oldest !== undefined) finalViewsRef.current.delete(oldest);
      }
    };
    const canAppend =
      previous &&
      previous.scene === svgScene &&
      previous.renderKey === renderKey &&
      step >= previous.step;

    if (canAppend) {
      const nextKey = appendCanvasLines(
        canvas,
        svgScene,
        previous.step,
        step,
        transform,
        lineWidth,
        lineOpacity,
      );
      if (nextKey) {
        previous.step = step;
        previous.renderKey = nextKey;
        canvasLineStateRef.current = previous;
        cacheFinal();
      }
      if (overlayCanvas) {
        drawCanvasOverlay(
          overlayCanvas,
          nailPoints,
          transform,
        );
      }
      return;
    }

    const nextKey = rebuildCanvasLines(
      canvas,
      svgScene,
      step,
      transform,
      lineWidth,
      lineOpacity,
    );
    if (nextKey) {
      canvasLineStateRef.current = {
        scene: svgScene,
        step,
        renderKey: nextKey,
      };
      cacheFinal();
    }
    if (overlayCanvas) {
      drawCanvasOverlay(
        overlayCanvas,
        nailPoints,
        transform,
      );
    }
  }, [
    activeSequenceId,
    canvasResizeTick,
    cullTransform,
    drawTransports,
    finalsOnly,
    lineOpacity,
    lineWidth,
    maxStep,
    nailPoints,
    step,
    svgScene,
  ]);

  useEffect(() => {
    if (finalsOnly || !playing || maxStep <= 0) return;
    let frameId = 0;
    let previousTime = performance.now();
    let accumulatedSteps = 0;

    const tick = (now: number) => {
      accumulatedSteps += ((now - previousTime) * stepsPerSecond) / 1000;
      previousTime = now;
      const advance = Math.floor(accumulatedSteps);
      if (advance > 0) {
        accumulatedSteps -= advance;
        setStep((current) => {
          const next = Math.min(maxStep, current + advance);
          if (next >= maxStep) setPlaying(false);
          return next;
        });
      }
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [finalsOnly, playing, stepsPerSecond, maxStep]);

  const scheduleCanvasRender = useCallback(() => {
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      setCullTransform(zoomTransformRef.current);
    });
  }, []);

  const setZoomTransformImmediate = useCallback(
    (
      nextTransform:
        | ZoomTransform
        | ((current: ZoomTransform) => ZoomTransform),
    ) => {
      const next =
        typeof nextTransform === "function"
          ? nextTransform(zoomTransformRef.current)
          : nextTransform;
      zoomTransformRef.current = next;
      scheduleCanvasRender();
    },
    [scheduleCanvasRender],
  );

  const loadSequence = useCallback(async (option: SequenceOption) => {
    requestedSequenceRef.current = option.id;
    const loadId = ++sequenceLoadRef.current;
    setError(null);
    try {
      const loaded = await loadPhysicalSequence(option);
      if (loadId !== sequenceLoadRef.current) return;
      setSequence(loaded.sequence);
      setActiveSequenceId(option.id);
      const url = new URL(window.location.href);
      url.searchParams.set("seq", option.id);
      window.history.replaceState(null, "", url);
      setStep(0);
      setPlaying(!finalsOnlyRef.current);
    } catch (e) {
      if (loadId !== sequenceLoadRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("textarea, select") ||
        (target instanceof HTMLInputElement && target.type !== "checkbox" && target.type !== "radio"))) return;
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (!direction || !galleryOrder.length) return;
      event.preventDefault();
      const current = Math.max(0, galleryOrder.findIndex(option => option.id === requestedSequenceRef.current));
      void loadSequence(galleryOrder[(current + direction + galleryOrder.length) % galleryOrder.length]!);
    };
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [galleryOrder, loadSequence]);

  // The playing artwork's group stays expanded so it is visible in the gallery.
  useEffect(() => {
    const group = activeOption?.group;
    if (!group) return;
    setOpenGroups((current) => (current.has(group) ? current : new Set(current).add(group)));
  }, [activeOption?.group]);

  useEffect(() => {
    if (layout.mode !== "overlay") setDrawerOpen(false);
  }, [layout.mode]);

  useEffect(() => {
    let alive = true;
    fetchGallery()
      .then((gallery) => {
        if (!alive) return;
        setSequences(gallery);
        setGalleryLoaded(true);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!galleryLoaded) return;
    if (sequences.length === 0) {
      setError("The gallery is empty");
      return;
    }
    if (initialSequenceLoadedRef.current) return;
    initialSequenceLoadedRef.current = true;
    const wanted = sequenceParam();
    void loadSequence(sequences.find((option) => option.id === wanted) ?? sequences[0]!);
  }, [galleryLoaded, loadSequence, sequences]);

  useEffect(() => {
    return () => {
      if (renderFrameRef.current !== null) {
        window.cancelAnimationFrame(renderFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const canvas = lineCanvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const requestResizeRender = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setViewport((current) =>
          current.width === window.innerWidth && current.height === window.innerHeight
            ? current
            : { width: window.innerWidth, height: window.innerHeight },
        );
        setCanvasResizeTick((tick) => tick + 1);
      });
    };
    const observer = new ResizeObserver(requestResizeRender);
    const onContextLost = (event: Event) => event.preventDefault();
    const onContextRestored = () => {
      webglRendererRef.current?.dispose();
      webglRendererRef.current = undefined;
      requestResizeRender();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    observer.observe(canvas);
    window.addEventListener("resize", requestResizeRender);
    return () => {
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      window.removeEventListener("resize", requestResizeRender);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const svgPointFromClient = useCallback((clientX: number, clientY: number) => {
    const canvas = lineCanvasRef.current;
    if (!canvas) return null;
    return clientPointToCanvasScene(
      canvas,
      zoomTransformRef.current,
      clientX,
      clientY,
    );
  }, []);

  const zoomAt = useCallback((clientX: number, clientY: number, scale: number) => {
    const point = svgPointFromClient(clientX, clientY);
    if (!point) return;
    setZoomTransformImmediate((current) => {
      const nextK = clamp(current.k * scale, MIN_ZOOM, MAX_ZOOM);
      const ratio = nextK / current.k;
      return {
        x: current.x + point.x * current.k * (1 - ratio),
        y: current.y + point.y * current.k * (1 - ratio),
        k: nextK,
      };
    });
  }, [setZoomTransformImmediate, svgPointFromClient]);

  const beginPinch = useCallback(() => {
    const canvas = lineCanvasRef.current;
    const pointers = [...activePointersRef.current.values()];
    if (!canvas || pointers.length < 2) return;
    const a = pointers[0]!;
    const b = pointers[1]!;
    const midpointX = (a.x + b.x) / 2;
    const midpointY = (a.y + b.y) / 2;
    const anchor = clientPointToCanvasScene(
      canvas,
      zoomTransformRef.current,
      midpointX,
      midpointY,
    );
    if (!anchor) return;
    pinchRef.current = {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      midpointX,
      midpointY,
      transform: zoomTransformRef.current,
      anchor,
    };
    dragRef.current = null;
  }, []);

  const updatePinch = useCallback(() => {
    const pinch = pinchRef.current;
    const pointers = [...activePointersRef.current.values()];
    if (!pinch || pointers.length < 2) return;
    const a = pointers[0]!;
    const b = pointers[1]!;
    const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const scale = distance / Math.max(1, pinch.distance);
    const nextK = clamp(pinch.transform.k * scale, MIN_ZOOM, MAX_ZOOM);
    const ratio = nextK / pinch.transform.k;
    setZoomTransformImmediate({
      x: pinch.transform.x + pinch.anchor.x * pinch.transform.k * (1 - ratio),
      y: pinch.transform.y + pinch.anchor.y * pinch.transform.k * (1 - ratio),
      k: nextK,
    });
  }, [setZoomTransformImmediate]);

  useEffect(() => {
    const canvas = lineCanvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      zoomAt(
        event.clientX,
        event.clientY,
        2 ** (-event.deltaY / WHEEL_ZOOM_DENOMINATOR),
      );
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const togglePlay = () => {
    if (completed) {
      setStep(0);
      setPlaying(true);
      return;
    }
    setPlaying((p) => !p);
  };

  /** After a delete: drop it here at once (Pages takes ~1 minute to catch up); if it was showing, show the next. */
  const removeFromGallery = (deleted: { id: string }) => {
    setDeleteTarget(null);
    const index = galleryOrder.findIndex((option) => option.id === deleted.id);
    const remaining = galleryOrder.filter((option) => option.id !== deleted.id);
    setSequences((current) => current.filter((option) => option.id !== deleted.id));
    if (requestedSequenceRef.current === deleted.id && remaining.length) {
      void loadSequence(remaining[Math.min(Math.max(0, index), remaining.length - 1)]!);
    }
  };

  /** Shares the artwork's share page (a/<id>/): unlike ?seq=, it gives chat apps a preview image. Phones get the
   * system share sheet; elsewhere the link is copied. */
  const shareArtwork = async (option: SequenceOption) => {
    const url = new URL(`${import.meta.env.BASE_URL}a/${encodeURIComponent(option.id)}/`, window.location.origin).href;
    const title = option.group && option.shortLabel ? `${option.group} · ${option.shortLabel}` : option.label;
    if (navigator.share && window.matchMedia("(hover: none)").matches) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy this link", url);
      return;
    }
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 1600);
  };

  const resetView = () => {
    const identity = { x: 0, y: 0, k: 1 };
    zoomTransformRef.current = identity;
    setCullTransform(identity);
  };

  const panel = (
    <aside
      className={`viewer-panel panel-${layout.mode}${drawerOpen ? " open" : ""}${storedToken() ? " has-token" : ""}`}
      style={
        layout.panel
          ? {
              left: layout.panel.left,
              top: layout.panel.top,
              width: layout.panel.width,
              height: layout.panel.height,
            }
          : undefined
      }
    >
      <header className="now-playing">
        <div className="now-heading">
          <div className="now-titles">
            <div className="now-kicker">{activeOption?.group ?? "String art"}</div>
            <h1 className="now-title">
              {activeOption ? activeOption.shortLabel ?? activeOption.label : "Loading…"}
            </h1>
          </div>
          <div className="heading-actions">
            {activeOption && (
              <button
                type="button"
                className={`share-button${linkCopied ? " copied" : ""}`}
                title="Copy a link that shows this artwork's preview in chats"
                onClick={() => void shareArtwork(activeOption)}
              >
                <LinkIcon />
                <span>{linkCopied ? "Copied" : "Share"}</span>
              </button>
            )}
            {layout.mode === "overlay" && (
              <button
                type="button"
                className="icon-button"
                aria-label="Close panel"
                onClick={() => setDrawerOpen(false)}
              >
                <CloseIcon />
              </button>
            )}
          </div>
        </div>

        {finalsOnly ? (
          <p className="now-meta">Showing finished artworks</p>
        ) : (
          <>
            <input
              className="scrubber"
              type="range"
              min={0}
              max={Math.max(1, maxStep)}
              step={1}
              value={step}
              disabled={!maxStep}
              aria-label="Construction progress"
              style={{ "--progress": `${maxStep ? (step / maxStep) * 100 : 0}%` } as React.CSSProperties}
              onChange={(e) => {
                setPlaying(false);
                setStep(Number(e.target.value));
              }}
            />
            <div className="now-meta">
              <span>
                {step.toLocaleString()} / {maxStep.toLocaleString()} threads
              </span>
              <span>{maxStep ? Math.floor((step / maxStep) * 100) : 0}%</span>
            </div>
            <div className="transport">
              <button
                type="button"
                className="icon-button"
                aria-label="Restart"
                title="Restart"
                disabled={!maxStep}
                onClick={() => {
                  setStep(0);
                  setPlaying(true);
                }}
              >
                <RestartIcon />
              </button>
              <button
                type="button"
                className="play-button"
                aria-label={playing ? "Pause" : "Play"}
                disabled={!maxStep}
                onClick={togglePlay}
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <label className="speed-control">
                <span className="speed-label">
                  Speed <b>{stepsPerSecond.toLocaleString()}</b>/s
                </span>
                <input
                  type="range"
                  min={0}
                  max={4}
                  step={0.01}
                  value={Math.log10(stepsPerSecond)}
                  aria-label="Threads per second"
                  onChange={(e) =>
                    setStepsPerSecond(
                      Math.max(1, Math.min(10000, Math.round(10 ** Number(e.target.value)))),
                    )
                  }
                />
              </label>
            </div>
          </>
        )}

        <div className="toggles">
          <label className="switch">
            <input
              type="checkbox"
              checked={finalsOnly}
              onChange={(e) => {
                const checked = e.target.checked;
                finalsOnlyRef.current = checked;
                setFinalsOnly(checked);
                setPlaying(!checked);
              }}
            />
            <span className="switch-track" aria-hidden="true" />
            Finals only
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={drawTransports}
              onChange={(e) => setDrawTransports(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
            Transports
          </label>
        </div>
        {error && <p className="stale-banner">{error}</p>}
      </header>

      <nav className="gallery" aria-label="Artworks">
        <div className="gallery-heading">
          <span>Gallery</span>
          <span className="gallery-count">{sequences.length}</span>
        </div>
        <ul className="gallery-list">
          {gallerySections.map((section) => {
            if (section.kind === "single") {
              const option = section.option;
              const active = option.id === activeSequenceId;
              return (
                <li key={option.id} className="gallery-entry">
                  <button
                    type="button"
                    className={`gallery-item${active ? " active" : ""}`}
                    aria-current={active ? "true" : undefined}
                    onClick={() => void loadSequence(option)}
                  >
                    <span className="item-dot" aria-hidden="true" />
                    <span className="item-name">{option.label}</span>
                  </button>
                  <DeleteButton label={option.label} onClick={() => setDeleteTarget(option)} />
                </li>
              );
            }
            const open = openGroups.has(section.name);
            const containsActive = section.options.some((option) => option.id === activeSequenceId);
            return (
              <li key={`group:${section.name}`} className={`gallery-group${open ? " open" : ""}`}>
                <button
                  type="button"
                  className={`gallery-item group-toggle${containsActive ? " has-active" : ""}`}
                  aria-expanded={open}
                  onClick={() =>
                    setOpenGroups((current) => {
                      const next = new Set(current);
                      if (next.has(section.name)) next.delete(section.name);
                      else next.add(section.name);
                      return next;
                    })
                  }
                >
                  <ChevronIcon />
                  <span className="item-name">{section.name}</span>
                  <span className="gallery-count">{section.options.length}</span>
                </button>
                {open && (
                  <ul className="group-items">
                    {section.options.map((option) => {
                      const active = option.id === activeSequenceId;
                      return (
                        <li key={option.id} className="chip-entry">
                          <button
                            type="button"
                            className={`chip${active ? " active" : ""}`}
                            aria-current={active ? "true" : undefined}
                            title={option.label}
                            onClick={() => void loadSequence(option)}
                          >
                            {option.shortLabel ?? option.label}
                          </button>
                          <DeleteButton label={option.label} onClick={() => setDeleteTarget(option)} />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      <p className="hint">Drag to pan · scroll or pinch to zoom · ← → to browse</p>
      {deleteTarget && (
        <DeleteDialog
          artwork={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onDeleted={removeFromGallery}
        />
      )}
    </aside>
  );

  return (
    <div className={`svg-viewer-page layout-${layout.mode}`}>
      <section className="panel svg-viewer-canvas-panel">
        <div className="physical-canvas-wrap">
          <canvas
            ref={lineCanvasRef}
            className="physical-canvas physical-line-canvas"
            role="img"
            aria-label="Physical sequence string art canvas preview"
            onPointerDown={(e) => {
              const canvas = lineCanvasRef.current;
              if (!canvas) return;
              if (drawerOpen) setDrawerOpen(false);
              activePointersRef.current.set(e.pointerId, {
                x: e.clientX,
                y: e.clientY,
              });
              e.preventDefault();
              canvas.setPointerCapture(e.pointerId);
              if (activePointersRef.current.size >= 2) {
                beginPinch();
                return;
              }
              const point = svgPointFromClient(e.clientX, e.clientY);
              if (!point) return;
              dragRef.current = {
                x: point.x,
                y: point.y,
                transform: zoomTransformRef.current,
              };
            }}
            onPointerMove={(e) => {
              if (activePointersRef.current.has(e.pointerId)) {
                activePointersRef.current.set(e.pointerId, {
                  x: e.clientX,
                  y: e.clientY,
                });
              }
              if (pinchRef.current) {
                e.preventDefault();
                updatePinch();
                return;
              }
              const drag = dragRef.current;
              if (!drag) return;
              const canvas = lineCanvasRef.current;
              if (!canvas) return;
              const point = clientPointToCanvasScene(
                canvas,
                drag.transform,
                e.clientX,
                e.clientY,
              );
              if (!point) return;
              e.preventDefault();
              const dx = point.x - drag.x;
              const dy = point.y - drag.y;
              setZoomTransformImmediate({
                ...drag.transform,
                x: drag.transform.x + dx * drag.transform.k,
                y: drag.transform.y + dy * drag.transform.k,
              });
            }}
            onPointerUp={() => {
              activePointersRef.current.clear();
              pinchRef.current = null;
              dragRef.current = null;
              setCullTransform(zoomTransformRef.current);
            }}
            onPointerCancel={() => {
              activePointersRef.current.clear();
              pinchRef.current = null;
              dragRef.current = null;
              setCullTransform(zoomTransformRef.current);
            }}
          />
          <canvas
            ref={overlayCanvasRef}
            className="physical-overlay-canvas"
            aria-hidden="true"
          />
        </div>
      </section>

      {layout.mode === "overlay" && (
        <>
          <button
            type="button"
            className="floating-button floating-menu"
            aria-label="Open gallery and controls"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <MenuIcon />
          </button>
          {!finalsOnly && (
            <button
              type="button"
              className="floating-button floating-play"
              aria-label={playing ? "Pause" : "Play"}
              disabled={!maxStep}
              onClick={togglePlay}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
          )}
        </>
      )}
      {zoomed && (
        <button
          type="button"
          className="floating-button floating-fit"
          aria-label="Fit artwork to screen"
          title="Fit to screen"
          onClick={resetView}
        >
          <FitIcon />
        </button>
      )}
      {panel}
    </div>
  );
}

/** Shown on hover over a gallery entry (always on touch screens once a token is saved on the device). */
function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="delete-button"
      aria-label={`Delete ${label}`}
      title="Delete from the site"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
        <path
          d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 10.5v5.5M13.5 10.5v5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

function PlayIcon() {
  return <Icon><path d="M8 5.5v13l10.5-6.5z" fill="currentColor" /></Icon>;
}

function PauseIcon() {
  return <Icon><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" /></Icon>;
}

function RestartIcon() {
  return (
    <Icon>
      <path d="M5 12a7 7 0 1 0 2.05-4.95" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M5 4v4.5h4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MenuIcon() {
  return <Icon><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></Icon>;
}

function CloseIcon() {
  return <Icon><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></Icon>;
}

function ChevronIcon() {
  return (
    <svg className="chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FitIcon() {
  return (
    <Icon>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  );
}
