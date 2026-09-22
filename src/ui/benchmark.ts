/**
 * src/ui/benchmark.ts — implements RunRenderBenchmark: the synthetic raw
 * WebGL triangle-soup benchmark scene (docs/spec/11-ui.md section 5.3).
 */
import type { BenchmarkResult, RunRenderBenchmark } from '../contracts/ui';

const VERTEX_SRC = `attribute vec2 aPos; attribute vec3 aColor; varying vec3 vColor;
void main() { vColor = aColor; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAGMENT_SRC = `precision mediump float; varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

type GlContext = WebGL2RenderingContext | WebGLRenderingContext;

function compileShader(gl: GlContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function buildProgram(gl: GlContext): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  if (vs === null || fs === null) return null;
  const program = gl.createProgram();
  if (program === null) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function getGlContext(canvas: HTMLCanvasElement): GlContext | null {
  try {
    const gl2 = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (gl2 !== null) return gl2;
    const gl1 = canvas.getContext('webgl') as WebGLRenderingContext | null;
    return gl1;
  } catch {
    return null;
  }
}

export const runRenderBenchmark: RunRenderBenchmark = (canvas, durationMs, warmupMs, triangleCount) => {
  return new Promise<BenchmarkResult>((resolve) => {
    const gl = getGlContext(canvas);
    if (gl === null) {
      resolve({ avgFrameMs: 0, fps: 0, samples: 0 });
      return;
    }

    const program = buildProgram(gl);
    if (program === null) {
      resolve({ avgFrameMs: 0, fps: 0, samples: 0 });
      return;
    }

    // 2 pos floats + 3 color floats per vertex, 3 vertices per triangle.
    const floatsPerVertex = 5;
    const vertexCount = triangleCount * 3;
    const data = new Float32Array(vertexCount * floatsPerVertex);
    for (let i = 0; i < vertexCount; i++) {
      const base = i * floatsPerVertex;
      data[base + 0] = Math.random() * 2 - 1;
      data[base + 1] = Math.random() * 2 - 1;
      data[base + 2] = Math.random();
      data[base + 3] = Math.random();
      data[base + 4] = Math.random();
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    gl.useProgram(program);
    const stride = floatsPerVertex * 4;
    const aPosLoc = gl.getAttribLocation(program, 'aPos');
    const aColorLoc = gl.getAttribLocation(program, 'aColor');
    if (aPosLoc >= 0) {
      gl.enableVertexAttribArray(aPosLoc);
      gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, stride, 0);
    }
    if (aColorLoc >= 0) {
      gl.enableVertexAttribArray(aColorLoc);
      gl.vertexAttribPointer(aColorLoc, 3, gl.FLOAT, false, stride, 2 * 4);
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);

    let frames = 0;
    let measuredMs = 0;
    const startedAt = performance.now();
    let lastNow = startedAt;

    function tick(now: number): void {
      const dt = now - lastNow;
      lastNow = now;
      if (now - startedAt >= warmupMs) {
        measuredMs += dt;
        frames++;
      }
      gl!.clear(gl!.COLOR_BUFFER_BIT);
      gl!.drawArrays(gl!.TRIANGLES, 0, vertexCount);
      if (now - startedAt < durationMs) {
        requestAnimationFrame(tick);
      } else {
        const avgFrameMs = measuredMs / Math.max(1, frames);
        resolve({ avgFrameMs, fps: 1000 / avgFrameMs, samples: frames });
      }
    }
    requestAnimationFrame(tick);
  });
};
