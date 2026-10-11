type Segment = { x1: number; y1: number; x2: number; y2: number; color: string; visibleStep: number };
type Scene = { lineIndex: { segments: Segment[] } };
type View = { x: number; y: number; k: number };

const vertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec4 endpoints;
layout(location=1) in vec3 color;
uniform vec2 viewport;
uniform vec3 view;
uniform float width;
out vec2 local;
out float lengthPx;
out vec3 threadColor;
const vec2 corners[6] = vec2[6](vec2(0,-1),vec2(1,-1),vec2(0,1),vec2(0,1),vec2(1,-1),vec2(1,1));
void main() {
  float scale = min(viewport.x, viewport.y) / 30.0;
  vec2 offset = (viewport - vec2(30.0 * scale)) * 0.5;
  vec2 a = offset + (endpoints.xy * view.z + view.xy + vec2(15)) * scale;
  vec2 b = offset + (endpoints.zw * view.z + view.xy + vec2(15)) * scale;
  vec2 delta = b-a;
  lengthPx = length(delta);
  vec2 direction = lengthPx > 0.0 ? delta / lengthPx : vec2(1,0);
  float extent = width * 0.5 + 1.0;
  vec2 corner = corners[gl_VertexID];
  local = vec2(mix(-extent,lengthPx+extent,corner.x), corner.y * extent);
  vec2 position = a + direction * local.x + vec2(-direction.y,direction.x) * local.y;
  gl_Position = vec4(position.x/viewport.x*2.0-1.0,1.0-position.y/viewport.y*2.0,0,1);
  threadColor = color;
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec2 local;
in float lengthPx;
in vec3 threadColor;
uniform float width;
out vec4 outputColor;
void main() {
  vec2 nearest = vec2(clamp(local.x,0.0,lengthPx),0);
  float coverage = clamp(width*0.5 + 0.5 - length(local-nearest),0.0,1.0);
  outputColor = vec4(threadColor * coverage,coverage);
}`;

export class WebGLThreadRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private buffers = new Map<Scene, WebGLBuffer>();
  private viewport: WebGLUniformLocation | null;
  private view: WebGLUniformLocation | null;
  private width: WebGLUniformLocation | null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: true });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(message ?? "Shader compilation failed");
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Shader linking failed");
    this.program = program;
    this.vao = gl.createVertexArray()!;
    this.viewport = gl.getUniformLocation(program, "viewport");
    this.view = gl.getUniformLocation(program, "view");
    this.width = gl.getUniformLocation(program, "width");
  }

  draw(scene: Scene, step: number, view: View, lineWidth: number) {
    const gl = this.gl;
    if (gl.isContextLost()) return false;
    const segments = scene.lineIndex.segments;
    let buffer = this.buffers.get(scene);
    if (!buffer) {
      const data = new Float32Array(segments.length * 7);
      const colors = new Map<string, number[]>();
      const colorCanvas = document.createElement("canvas");
      colorCanvas.width = colorCanvas.height = 1;
      const ctx = colorCanvas.getContext("2d", { willReadFrequently: true })!;
      segments.forEach((segment, index) => {
        let color = colors.get(segment.color);
        if (!color) {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = segment.color;
          ctx.fillRect(0, 0, 1, 1);
          color = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => value / 255);
          colors.set(segment.color, color);
        }
        data.set([segment.x1, segment.y1, segment.x2, segment.y2, ...color], index * 7);
      });
      buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      this.buffers.set(scene, buffer);
      if (this.buffers.size > 3) {
        const oldest = this.buffers.keys().next().value;
        if (oldest) { gl.deleteBuffer(this.buffers.get(oldest)!); this.buffers.delete(oldest); }
      }
    } else {
      this.buffers.delete(scene);
      this.buffers.set(scene, buffer);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 28, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.uniform2f(this.viewport, this.canvas.width, this.canvas.height);
    gl.uniform3f(this.view, view.x, view.y, view.k);
    gl.uniform1f(this.width, Math.max(0.5, lineWidth * view.k * Math.min(this.canvas.width, this.canvas.height) / 30));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    let lo = 0, hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid]!.visibleStep <= step) lo = mid + 1;
      else hi = mid;
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, lo);
    return true;
  }

  dispose() {
    for (const buffer of this.buffers.values()) this.gl.deleteBuffer(buffer);
    this.buffers.clear();
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }
}
