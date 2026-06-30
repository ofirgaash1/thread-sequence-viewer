import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { strFromU8, unzipSync } from "fflate";

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
  url: string;
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

function isPhysicalSequenceExport(value: unknown): value is PhysicalSequenceExport {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { instructions?: unknown };
  return Array.isArray(maybe.instructions);
}

const SEQUENCES: SequenceOption[] = [
  {
    id: "mona-lisa",
    label: "Mona Lisa",
    url: `${import.meta.env.BASE_URL}sequences/mona-lisa.zip`,
  },
];

function numberParam(name: string, fallback: number): number {
  const value = new URLSearchParams(window.location.search).get(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

async function loadPhysicalSequence(option: SequenceOption): Promise<{
  sequence: PhysicalSequenceExport;
  displayName: string;
}> {
  const response = await fetch(option.url);
  if (!response.ok) {
    throw new Error(`Could not load ${option.label}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
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

function visibleSceneRect(transform: ZoomTransform): SceneRect {
  if (transform.k < CULL_ZOOM_THRESHOLD) return fullSceneRect();
  const minX = (SVG_MIN - transform.x) / transform.k;
  const minY = (SVG_MIN - transform.y) / transform.k;
  const maxX = (SVG_MAX - transform.x) / transform.k;
  const maxY = (SVG_MAX - transform.y) / transform.k;
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
  const scale = Math.min(width / SVG_SIZE, height / SVG_SIZE);
  return {
    cssWidth: rect.width,
    cssHeight: rect.height,
    width,
    height,
    dpr,
    scale,
    offsetX: (width - SVG_SIZE * scale) / 2,
    offsetY: (height - SVG_SIZE * scale) / 2,
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
  const scale = Math.min(rect.width / SVG_SIZE, rect.height / SVG_SIZE);
  const offsetX = (rect.width - SVG_SIZE * scale) / 2;
  const offsetY = (rect.height - SVG_SIZE * scale) / 2;
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
    transform.k >= CULL_ZOOM_THRESHOLD ? visibleSceneRect(transform) : null;
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
  const ctx = canvas.getContext("2d");
  if (!metrics || !ctx) return null;
  const key = canvasRenderKey(metrics, transform, lineWidth, lineOpacity);
  const cullRect =
    transform.k >= CULL_ZOOM_THRESHOLD ? visibleSceneRect(transform) : null;
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
  const ctx = canvas.getContext("2d");
  if (!metrics || !ctx) return null;
  const key = canvasRenderKey(metrics, transform, lineWidth, lineOpacity);
  const cullRect =
    transform.k >= CULL_ZOOM_THRESHOLD ? visibleSceneRect(transform) : null;
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
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [stepsPerSecond, setStepsPerSecond] = useState(160);
  const [activeSequenceId, setActiveSequenceId] = useState(SEQUENCES[0]!.id);
  const [canvasResizeTick, setCanvasResizeTick] = useState(0);
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
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<PinchState | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    transform: ZoomTransform;
  } | null>(null);

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
  const completed = maxStep > 0 && step >= maxStep;
  const circleDiameterCm = useMemo(() => numberParam("diameter", 60), []);
  const threadWidthMm = useMemo(() => numberParam("width", 0.3), []);
  const lineWidth = useMemo(() => {
    const diameterMm = Math.max(1, circleDiameterCm * 10);
    return Math.max(0.001, (RADIUS * 2 * threadWidthMm) / diameterMm);
  }, [circleDiameterCm, threadWidthMm]);
  const lineOpacity = 1;
  const drawCommands = useMemo<(DrawCommand | null)[]>(() => {
    if (nailCount <= 1) return instructions.map(() => null);
    return instructions.map((instr) => {
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
  }, [colorByName, instructions, nailCount]);
  const svgScene = useMemo(() => buildSvgScene(drawCommands), [drawCommands]);
  const nailPoints = useMemo(() => {
    if (nailCount <= 1) return [];
    return Array.from({ length: nailCount }, (_, nail) =>
      nailPoint(nail, nailCount),
    );
  }, [nailCount]);

  useLayoutEffect(() => {
    const canvas = lineCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!canvas) return;

    const transform = zoomTransformRef.current;
    const previous = canvasLineStateRef.current;
    const metrics = resizeCanvasToDisplay(canvas);
    if (!metrics) return;
    const renderKey = canvasRenderKey(metrics, transform, lineWidth, lineOpacity);
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
    }
    if (overlayCanvas) {
      drawCanvasOverlay(
        overlayCanvas,
        nailPoints,
        transform,
      );
    }
  }, [
    canvasResizeTick,
    cullTransform,
    lineOpacity,
    lineWidth,
    nailPoints,
    step,
    svgScene,
  ]);

  useEffect(() => {
    if (!playing || maxStep <= 0) return;
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
  }, [playing, stepsPerSecond, maxStep]);

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
    setError(null);
    try {
      const loaded = await loadPhysicalSequence(option);
      setSequence(loaded.sequence);
      setActiveSequenceId(option.id);
      setStep(0);
      setPlaying(true);
      setZoomTransformImmediate({ x: 0, y: 0, k: 1 });
      setCullTransform({ x: 0, y: 0, k: 1 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [setZoomTransformImmediate]);

  useEffect(() => {
    void loadSequence(SEQUENCES[0]!);
  }, [loadSequence]);

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
        setCanvasResizeTick((tick) => tick + 1);
      });
    };
    const observer = new ResizeObserver(requestResizeRender);
    observer.observe(canvas);
    window.addEventListener("resize", requestResizeRender);
    return () => {
      observer.disconnect();
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

  return (
    <div className="svg-viewer-page">
      <section className="viewer-controls">
        <div className="sequence-buttons">
          {SEQUENCES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={option.id === activeSequenceId ? "active" : undefined}
              onClick={() => void loadSequence(option)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="playback-controls">
          <button
            type="button"
            disabled={!maxStep}
            onClick={() => {
              if (completed) {
                setStep(0);
                setPlaying(true);
                return;
              }
              setPlaying((p) => !p);
            }}
          >
            {completed ? "Restart" : playing ? "Pause" : "Play"}
          </button>
          <label className="speed-control">
            <input
              type="range"
              min={0}
              max={4}
              step={0.01}
              value={Math.log10(stepsPerSecond)}
              onChange={(e) =>
                setStepsPerSecond(
                  Math.max(
                    1,
                    Math.min(10000, Math.round(10 ** Number(e.target.value))),
                  ),
                )
              }
            />
            <span>
              {stepsPerSecond.toLocaleString()}
              <span className="per-second">/sec</span>
            </span>
          </label>
          <span className="zoom-hint">scroll to zoom</span>
          <span className="step-counter">{step.toLocaleString()} / {maxStep.toLocaleString()}</span>
        </div>
        {error && <p className="stale-banner">{error}</p>}
      </section>
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
    </div>
  );
}
