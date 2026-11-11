/**
 * 3D view of the threads as built (prototype). Two rules:
 *
 * - The pile: a smooth height field on cells a few threads wide. Each thread, in build order, adds its own volume over
 *   the cells under its path (bilinear splats), so a point's height is the local density of threads there: the
 *   threads are pressed together by their tension, as on a real board.
 * - Each thread is taut: it rests on the pile already under its path and is straight between the points it rests on,
 *   so its profile is the upper hull of that pile from nail to nail (half a thickness above it). Its slope only ever
 *   decreases along it (up, level, down); it never dips into the hollows between the points it rests on.
 *
 * The lifted thread does not itself become pile (only its volume does): when it did, every thread rode on the last
 * one's lifted span and the heights compounded into towers thousands of threads tall. Near its own nails (4% of the
 * radius) a thread adds no volume: the threads of one nail fan out around it.
 *
 * Heights are computed once per sequence (a second or two for 100k threads). Each thread draws as the straight pieces
 * between its hull's corners, with depth; the playback step shows the first threads as in 2D. Drag rotates, the wheel
 * zooms, double-click resets; it turns slowly on its own until touched.
 */
import { useEffect, useMemo, useRef, useState } from "react";

export type Line3DInput = { x1: number; y1: number; x2: number; y2: number; color: string; step: number; nailA: number; nailB: number };

type Built = {
  /** per segment: ax, ay, az, bx, by, bz, r, g, b */
  data: Float32Array;
  /** per segment: its thread's playback step (ascending) */
  steps: Float32Array;
  segments: number;
  maxHeight: number;
};

const FLOATS = 9;
const CELL_THREADS = 6; // pile cell size in thread widths (?cell=): smaller is rougher, larger is smoother
const NAIL_ZONE = 0.04; // of the radius: how far from its nails a thread is in the wraps' fan (adds no pile)

function parseColor(css: string, cache: Map<string, [number, number, number]>, ctx: CanvasRenderingContext2D): [number, number, number] {
  let rgb = cache.get(css);
  if (!rgb) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    rgb = [d[0]! / 255, d[1]! / 255, d[2]! / 255];
    cache.set(css, rgb);
  }
  return rgb;
}

/** Heights (see above); coordinates relative to the board centre, y up, z up from the board. */
export function buildHeights(lines: Line3DInput[], cx: number, cy: number, radius: number, thickness: number, cellThreads = CELL_THREADS): Built {
  const G = Math.max(32, Math.min(1024, Math.round((2 * radius) / (thickness * cellThreads))));
  const cell = (2 * radius) / G;
  const H = new Float32Array((G + 1) * (G + 1)); // heights at cell corners
  let data = new Float32Array(Math.max(1024, lines.length * 8 * FLOATS));
  let steps = new Float32Array(data.length / FLOATS);
  let n = 0;
  let maxHeight = 0;
  const half = thickness / 2;
  const colorCache = new Map<string, [number, number, number]>();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  let cap = 4096;
  let z = new Float32Array(cap), fx = new Float32Array(cap), fy = new Float32Array(cap), keep = new Uint8Array(cap), stack = new Int32Array(2 * cap);
  const W = G + 1;
  for (const line of lines) {
    const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
    const length = Math.hypot(dx, dy);
    const S = Math.max(2, Math.ceil((2 * length) / cell) + 1); // two samples per cell
    if (S > cap) {
      cap = S * 2;
      z = new Float32Array(cap); fx = new Float32Array(cap); fy = new Float32Array(cap); keep = new Uint8Array(cap); stack = new Int32Array(2 * cap);
    }
    // the surface under the path (bilinear): the thread's centre lies half a thickness above it
    for (let j = 0; j < S; j++) {
      const t = j / (S - 1);
      const gx = Math.min(G - 1e-6, Math.max(0, (line.x1 + dx * t - cx + radius) / cell));
      const gy = Math.min(G - 1e-6, Math.max(0, (line.y1 + dy * t - cy + radius) / cell));
      fx[j] = gx; fy[j] = gy;
      const i0 = Math.floor(gx), j0 = Math.floor(gy), ax = gx - i0, ay = gy - j0, o = j0 * W + i0;
      z[j] = half + (H[o]! * (1 - ax) + H[o + 1]! * ax) * (1 - ay) + (H[o + W]! * (1 - ax) + H[o + W + 1]! * ax) * ay;
    }
    // taut: the thread is the upper hull of the pile under it, nail to nail (straight between the points it rests on,
    // its slope only ever decreasing along it), never dipping into the hollows between them
    keep.fill(0, 0, S);
    let top = 0;
    for (let k = 0; k < S; k++) {
      while (top >= 2) {
        const o = stack[top - 2]!, a = stack[top - 1]!;
        if ((a - o) * (z[k]! - z[o]!) - (z[a]! - z[o]!) * (k - o) >= 0) top--; // a is on or under the line o-k
        else break;
      }
      stack[top++] = k;
    }
    for (let h = 0; h < top; h++) {
      keep[stack[h]!] = 1;
      if (z[stack[h]!]! + half > maxHeight) maxHeight = z[stack[h]!]! + half;
    }
    let corners = 0;
    for (let k = 0; k < S; k++) corners += keep[k]!;
    if (n + corners > steps.length) {
      const grow = new Float32Array(Math.max(data.length * 2, (n + corners) * FLOATS * 2));
      grow.set(data);
      data = grow;
      const growSteps = new Float32Array(data.length / FLOATS);
      growSteps.set(steps);
      steps = growSteps;
    }
    const [r, g, bl] = parseColor(line.color, colorCache, ctx);
    let k0 = 0;
    for (let k1 = 1; k1 < S; k1++) {
      if (!keep[k1]) continue;
      const s0 = k0 / (S - 1), s1 = k1 / (S - 1);
      const o = n * FLOATS;
      data[o] = line.x1 + dx * s0 - cx; data[o + 1] = -(line.y1 + dy * s0 - cy); data[o + 2] = z[k0]!;
      data[o + 3] = line.x1 + dx * s1 - cx; data[o + 4] = -(line.y1 + dy * s1 - cy); data[o + 5] = z[k1]!;
      data[o + 6] = r; data[o + 7] = g; data[o + 8] = bl;
      steps[n] = line.step;
      n++;
      k0 = k1;
    }
    // its volume onto the pile: each sample's piece (length x width x thickness) spread over the cell (bilinear)
    const add = (thickness * thickness * (length / (S - 1))) / (cell * cell);
    for (let k = 0; k < S; k++) {
      const t = k / (S - 1);
      if (Math.min(t, 1 - t) * length < NAIL_ZONE * radius) continue;
      const gx = fx[k]!, gy = fy[k]!;
      const i0 = Math.floor(gx), j0 = Math.floor(gy), ax = gx - i0, ay = gy - j0, o = j0 * W + i0;
      H[o] += add * (1 - ax) * (1 - ay); H[o + 1] += add * ax * (1 - ay);
      H[o + W] += add * (1 - ax) * ay; H[o + W + 1] += add * ax * ay;
      if (H[o]! > maxHeight) maxHeight = H[o]!;
    }
  }
  return { data: data.subarray(0, n * FLOATS), steps: steps.subarray(0, n), segments: n, maxHeight: maxHeight + thickness };
}

const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 a;
layout(location=1) in vec3 b;
layout(location=2) in vec3 color;
uniform mat4 mvp;
uniform vec2 viewport;
uniform float widthPx;
uniform float lift;
uniform float maxHeight;
out vec3 shade;
const vec2 corners[6] = vec2[6](vec2(0,-1),vec2(1,-1),vec2(0,1),vec2(0,1),vec2(1,-1),vec2(1,1));
void main() {
  vec4 ca = mvp * vec4(a.xy, a.z * lift, 1.0);
  vec4 cb = mvp * vec4(b.xy, b.z * lift, 1.0);
  vec2 sa = ca.xy / ca.w * 0.5 * viewport, sb = cb.xy / cb.w * 0.5 * viewport;
  vec2 d = sb - sa; float len = length(d);
  vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec2 corner = corners[gl_VertexID];
  vec4 c = corner.x < 0.5 ? ca : cb;
  vec2 offset = normal * corner.y * widthPx * 0.5 + dir * (corner.x < 0.5 ? -0.5 : 0.5) * widthPx * 0.5;
  c.xy += offset / (0.5 * viewport) * c.w;
  gl_Position = c;
  float z = corner.x < 0.5 ? a.z : b.z;
  shade = color * (0.72 + 0.28 * clamp(z / max(maxHeight, 1e-6), 0.0, 1.0));
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec3 shade;
out vec4 outColor;
void main() { outColor = vec4(shade, 1.0); }`;

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
  return m;
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
    out[c * 4 + r] = s;
  }
  return out;
}

/** Orbit camera: board centre at the origin, z up. */
function viewMatrix(yaw: number, pitch: number, distance: number): Float32Array {
  const eye = [distance * Math.cos(pitch) * Math.sin(yaw), -distance * Math.cos(pitch) * Math.cos(yaw), distance * Math.sin(pitch)];
  const f = [-eye[0]!, -eye[1]!, -eye[2]!];
  const fl = Math.hypot(f[0]!, f[1]!, f[2]!);
  const fx = f[0]! / fl, fy = f[1]! / fl, fz = f[2]! / fl;
  // right = f x up(0,0,1)
  let rx = fy, ry = -fx, rz = 0;
  const rl = Math.hypot(rx, ry) || 1;
  rx /= rl; ry /= rl;
  // true up = right x f
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const m = new Float32Array(16);
  m[0] = rx; m[4] = ry; m[8] = rz;
  m[1] = ux; m[5] = uy; m[9] = uz;
  m[2] = -fx; m[6] = -fy; m[10] = -fz;
  m[12] = -(rx * eye[0]! + ry * eye[1]! + rz * eye[2]!);
  m[13] = -(ux * eye[0]! + uy * eye[1]! + uz * eye[2]!);
  m[14] = fx * eye[0]! + fy * eye[1]! + fz * eye[2]!;
  m[15] = 1;
  return m;
}

type Props = {
  lines: Line3DInput[];
  center: { x: number; y: number };
  radius: number;
  /** thread width in scene units */
  thickness: number;
  nailCount: number;
  step: number;
};

const DEFAULT_CAMERA = { yaw: 0.35, pitch: 0.7, distance: 4 };

export function Viewer3D({ lines, center, radius, thickness, nailCount, step }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const [lift, setLift] = useState(() => Number(new URLSearchParams(window.location.search).get("lift")) || 1);
  const camera = useRef({ ...DEFAULT_CAMERA });
  const touched = useRef(false);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;
  const liftRef = useRef(lift);
  liftRef.current = lift;

  // heights: once per sequence, after a frame so "Building" shows
  useEffect(() => {
    setBuilt(null);
    const handle = window.setTimeout(() => setBuilt(buildHeights(lines, center.x, center.y, radius, thickness, Number(new URLSearchParams(window.location.search).get("cell")) || CELL_THREADS)), 30);
    return () => window.clearTimeout(handle);
  }, [lines, center.x, center.y, radius, thickness, nailCount]);

  const realHeightText = useMemo(() => {
    if (!built) return "";
    const layers = Math.round(built.maxHeight / thickness);
    return `The stack is ${layers.toLocaleString()} threads thick at its highest (shown ${lift}× taller)`;
  }, [built, thickness, lift]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !built) return;
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!gl) return;
    const compile = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, built.data, gl.STATIC_DRAW);
    const stride = FLOATS * 4;
    for (const [loc, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 3, 24]] as const) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    const u = (name: string) => gl.getUniformLocation(program, name);
    const uMvp = u("mvp"), uViewport = u("viewport"), uWidth = u("widthPx"), uLift = u("lift"), uMax = u("maxHeight");
    let frame = 0;
    let last = performance.now();
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!touched.current && !drag.current) camera.current.yaw += dt * 0.15;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      const cam = camera.current;
      const fov = 0.6;
      const proj = perspective(fov, w / h, radius * 0.05, radius * 50);
      const mvp = multiply(proj, viewMatrix(cam.yaw, cam.pitch, cam.distance * radius));
      gl.uniformMatrix4fv(uMvp, false, mvp);
      gl.uniform2f(uViewport, w, h);
      const pxPerUnit = h / (2 * cam.distance * radius * Math.tan(fov / 2));
      gl.uniform1f(uWidth, Math.max(1, thickness * pxPerUnit));
      gl.uniform1f(uLift, liftRef.current);
      gl.uniform1f(uMax, built.maxHeight);
      // the first threads, as far as the playback has come
      let lo = 0, hi = built.segments;
      const s = stepRef.current;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (built.steps[mid]! <= s) lo = mid + 1; else hi = mid; }
      if (lo) gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, lo);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    };
  }, [built, radius, thickness]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      camera.current.distance = Math.min(12, Math.max(0.4, camera.current.distance * 2 ** (e.deltaY / 600)));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="viewer3d">
      <canvas
        ref={canvasRef}
        className="viewer3d-canvas"
        onPointerDown={(e) => {
          touched.current = true;
          drag.current = { x: e.clientX, y: e.clientY, yaw: camera.current.yaw, pitch: camera.current.pitch };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          camera.current.yaw = d.yaw - (e.clientX - d.x) * 0.008;
          camera.current.pitch = Math.min(1.55, Math.max(0.12, d.pitch + (e.clientY - d.y) * 0.008));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={() => { camera.current = { ...DEFAULT_CAMERA }; touched.current = false; }}
      />
      <div className="viewer3d-bar">
        {built ? <span>{realHeightText}</span> : <span>Building the stack…</span>}
        <label>
          Height ×
          <input type="range" min={1} max={20} step={1} value={lift} onChange={(e) => setLift(Number(e.target.value))} aria-label="Height exaggeration" />
        </label>
      </div>
    </div>
  );
}
