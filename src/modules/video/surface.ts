import type { VideoSurface } from "./api";

/**
 * The video canvas: fetches decoded I420 frames from `cs://localhost/frame?after=N` and draws
 * them with WebGL2 (BT.709 limited range → RGB), letterboxed on black.
 */

// Custom schemes are exposed as http://<scheme>.localhost on Windows and <scheme>://localhost elsewhere.
const BASE = navigator.userAgent.includes("Windows") ? "http://cs.localhost/" : "cs://localhost/";

const VERTEX = `#version 300 es
in vec2 p; out vec2 uv; uniform vec2 scale;
void main(){ uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p * scale, 0, 1); }`;
const FRAGMENT = `#version 300 es
precision mediump float; in vec2 uv; out vec4 o; uniform sampler2D ty, tu, tv;
void main(){
  float y = (texture(ty, uv).r - .0627) * 1.164, u = texture(tu, uv).r - .5, v = texture(tv, uv).r - .5;
  o = vec4(y + 1.793 * v, y - .213 * u - .533 * v, y + 2.112 * u, 1);
}`;

const HEADER_BYTES = 16;
/** How long to wait before asking again after "no new frame" and after a failed request. */
const IDLE_DELAY_MS = 30;
const ERROR_DELAY_MS = 200;

interface Frame {
  width: number;
  height: number;
  data: Uint8Array;
}

export function createVideoSurface(): VideoSurface {
  const el = document.createElement("canvas");
  el.style.cssText = "display:block;width:100%;height:100%;background:#000";
  const pixelSize = { width: 1, height: 1 };

  const gl = el.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: false });
  if (!gl) console.error("video: WebGL2 is not available");

  let program: WebGLProgram | null = null;
  let quad: WebGLBuffer | null = null;
  const textures: WebGLTexture[] = [];
  let scaleUniform: WebGLUniformLocation | null = null;
  let uploadedSize = "";
  let last: Frame | null = null;

  if (gl) {
    program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error("video:", gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.bindAttribLocation(program, 0, "p");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.error("video:", gl.getProgramInfoLog(program));
    gl.useProgram(program);
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    scaleUniform = gl.getUniformLocation(program, "scale");
    ["ty", "tu", "tv"].forEach((name, unit) => {
      const texture = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program!, name), unit);
      textures.push(texture);
    });
  }

  function clear() {
    if (!gl) return;
    gl.viewport(0, 0, el.width, el.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Uploads the planes (new storage when the size changed) and draws them letterboxed. */
  function draw(frame: Frame, upload: boolean) {
    if (!gl) return;
    const { width: w, height: h, data } = frame;
    if (upload) {
      const key = `${w}x${h}`;
      const fresh = key !== uploadedSize;
      uploadedSize = key;
      const planes: [number, number, number][] = [
        [w, h, 0],
        [w / 2, h / 2, w * h],
        [w / 2, h / 2, w * h + (w * h) / 4],
      ];
      planes.forEach(([pw, ph, offset], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
        const pixels = data.subarray(offset, offset + pw * ph);
        if (fresh) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, pw, ph, 0, gl.RED, gl.UNSIGNED_BYTE, pixels);
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pw, ph, gl.RED, gl.UNSIGNED_BYTE, pixels);
      });
    }
    const fit = Math.min(el.width / w, el.height / h);
    gl.uniform2f(scaleUniform, (w * fit) / el.width, (h * fit) / el.height);
    clear();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // The backing store follows the element's size in device pixels.
  const observer = new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(el.clientWidth * dpr));
    const height = Math.max(1, Math.round(el.clientHeight * dpr));
    if (width === el.width && height === el.height) return;
    el.width = width;
    el.height = height;
    pixelSize.width = width;
    pixelSize.height = height;
    if (last) draw(last, false);
    else clear();
  });
  observer.observe(el);

  let running = false;
  let disposed = false;
  let abort: AbortController | null = null;
  /** Bumped on every start() so a loop from an earlier start() exits instead of doubling up. */
  let generation = 0;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function pump(mine: number) {
    let after = 0;
    while (running && mine === generation) {
      let response: Response;
      try {
        abort = new AbortController();
        response = await fetch(`${BASE}frame?after=${after}`, { cache: "no-store", signal: abort.signal });
      } catch {
        if (running && mine === generation) await sleep(ERROR_DELAY_MS);
        continue;
      }
      if (response.status !== 200) {
        // 204: nothing new (the request already waited); anything else: back off.
        await sleep(response.status === 204 ? IDLE_DELAY_MS : ERROR_DELAY_MS);
        continue;
      }
      let buffer: ArrayBuffer;
      try {
        buffer = await response.arrayBuffer();
      } catch {
        await sleep(ERROR_DELAY_MS);
        continue;
      }
      if (!running || mine !== generation || buffer.byteLength < HEADER_BYTES) continue;
      const [width, height, , counter] = new Uint32Array(buffer, 0, 4);
      // A new file restarts nothing (the counter only grows), but guard against a stale reply.
      after = counter;
      if (!width || !height || buffer.byteLength < HEADER_BYTES + (width * height * 3) / 2) continue;
      last = { width, height, data: new Uint8Array(buffer, HEADER_BYTES) };
      draw(last, true);
    }
  }

  return {
    el,
    start() {
      if (running || disposed) return;
      running = true;
      void pump(++generation);
    },
    stop() {
      running = false;
      abort?.abort();
    },
    get pixelSize() {
      return pixelSize;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      abort?.abort();
      observer.disconnect();
      last = null;
      if (gl) {
        for (const texture of textures) gl.deleteTexture(texture);
        gl.deleteBuffer(quad);
        gl.deleteProgram(program);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    },
  };
}
