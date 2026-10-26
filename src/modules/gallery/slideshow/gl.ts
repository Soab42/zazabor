import { shotAt } from "./motion";
import type { FrameState, Renderer, SlideFrame, SlideTexture } from "./renderer";

export const VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  // One oversized triangle covering the screen; vUv has its origin at the top-left.
  vec2 pos = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vec2 uv = (pos + 1.0) * 0.5;
  vUv = vec2(uv.x, 1.0 - uv.y);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

export const COMMON = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
const float PI = 3.14159265;
float hash12(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p))) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n) * (1.0 / 4294967295.0);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/** Draws one slide (Ken Burns crop, or fitted photo over a blurred backdrop) into a frame. */
const COMPOSE = `${COMMON}
uniform sampler2D uImage;
uniform int uMode;        // 0 = fill, 1 = fit
uniform vec4 uRect;       // fill: crop in image uv. fit: photo placement in frame uv.
uniform float uRoll;      // fill: radians the crop turns about its center
uniform float uAspect;    // image width over height
uniform vec4 uBack;       // fit: backdrop crop in image uv
uniform vec2 uBand;       // frame top and height, in screen uv (letterbox)
uniform vec2 uFramePx;    // frame size in pixels
uniform sampler2D uBlur;  // the slide, Gaussian-blurred once at upload

void main() {
  vec2 f = vec2(vUv.x, (vUv.y - uBand.x) / uBand.y);
  if (uMode == 0) {
    // Turn the crop about its center in square pixels, so a camera roll doesn't shear.
    vec2 square = vec2(uAspect, 1.0);
    vec2 d = (f - 0.5) * uRect.zw * square;
    float c = cos(uRoll), s = sin(uRoll);
    d = vec2(c * d.x - s * d.y, s * d.x + c * d.y) / square;
    outColor = vec4(texture(uImage, uRect.xy + 0.5 * uRect.zw + d).rgb, 1.0);
    return;
  }
  // Frosted glass: the blurred photo, a touch more saturated and gently dimmed.
  vec3 back = texture(uBlur, uBack.xy + f * uBack.zw).rgb;
  back = mix(vec3(luma(back)), back, 1.15) * 0.78 + 0.03;
  // Soft contact shadow around the photo.
  vec2 outside = max(max(uRect.xy - f, f - (uRect.xy + uRect.zw)), 0.0) * uFramePx;
  back *= 1.0 - 0.45 * exp(-length(outside) / (0.03 * uFramePx.y));
  vec2 local = (f - uRect.xy) / uRect.zw;
  vec2 edge = min(local, 1.0 - local) * uRect.zw * uFramePx;
  float cover = clamp(min(edge.x, edge.y) + 0.5, 0.0, 1.0);
  vec3 photo = texture(uImage, clamp(local, 0.0, 1.0)).rgb;
  outColor = vec4(mix(back, photo, cover), 1.0);
}`;

/** Blends the two composed frames with a transition, then grades and finishes the picture. */
export const FINAL = `${COMMON}
uniform sampler2D uA;
uniform sampler2D uB;
uniform int uKind;        // -2 black, -1 A only, otherwise a transition id
uniform float uP;
uniform vec2 uDir;
uniform float uSeed;
uniform vec2 uRes;
uniform float uTime;
uniform float uFade;
uniform float uBars;
uniform float uGrain;
uniform float uVignette;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform float uSat;
uniform float uContrast;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;

vec2 flipY(vec2 uv) { return vec2(uv.x, 1.0 - uv.y); }
vec3 A(vec2 uv) { return texture(uA, flipY(uv)).rgb; }
vec3 B(vec2 uv) { return texture(uB, flipY(uv)).rgb; }
float ease(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }

vec3 blurA(vec2 uv, float lod) {
  vec2 px = exp2(lod) / uRes;
  vec3 c = textureLod(uA, flipY(uv), lod).rgb * 0.4;
  c += textureLod(uA, flipY(uv + vec2(px.x, 0.0)), lod).rgb * 0.15;
  c += textureLod(uA, flipY(uv - vec2(px.x, 0.0)), lod).rgb * 0.15;
  c += textureLod(uA, flipY(uv + vec2(0.0, px.y)), lod).rgb * 0.15;
  c += textureLod(uA, flipY(uv - vec2(0.0, px.y)), lod).rgb * 0.15;
  return c;
}
vec3 blurB(vec2 uv, float lod) {
  vec2 px = exp2(lod) / uRes;
  vec3 c = textureLod(uB, flipY(uv), lod).rgb * 0.4;
  c += textureLod(uB, flipY(uv + vec2(px.x, 0.0)), lod).rgb * 0.15;
  c += textureLod(uB, flipY(uv - vec2(px.x, 0.0)), lod).rgb * 0.15;
  c += textureLod(uB, flipY(uv + vec2(0.0, px.y)), lod).rgb * 0.15;
  c += textureLod(uB, flipY(uv - vec2(0.0, px.y)), lod).rgb * 0.15;
  return c;
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.1 + 7.3) + 0.15 * vnoise(p * 4.3 + 1.7);
}

float aspectRatio() { return uRes.x / uRes.y; }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
vec2 hash22(vec2 p) { return vec2(hash12(p * 1.0 + 3.7), hash12(p * 1.0 + 41.3)); }
bool inside(vec2 q) { return q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0; }
vec3 As(vec2 q) { return inside(q) ? A(q) : vec3(0.02); }
vec3 Bs(vec2 q) { return inside(q) ? B(q) : vec3(0.02); }
float inOutCubic(float x) { x = clamp(x, 0.0, 1.0); return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }
float outBounce(float x) {
  const float n = 7.5625, d = 2.75;
  if (x < 1.0 / d) return n * x * x;
  if (x < 2.0 / d) { x -= 1.5 / d; return n * x * x + 0.75; }
  if (x < 2.5 / d) { x -= 2.25 / d; return n * x * x + 0.9375; }
  x -= 2.625 / d; return n * x * x + 0.984375;
}
vec3 rotY(vec3 v, float a) { return vec3(v.x * cos(a) - v.z * sin(a), v.y, v.x * sin(a) + v.z * cos(a)); }

// Casts a ray from a camera behind the screen through screen point s (both axes -1..1) onto
// a plane through p0 spanned by unit axes U and V. Returns false when the ray misses it.
bool hitPlane(vec2 s, vec3 p0, vec3 U, vec3 V, out vec2 local, out float t, out float facing) {
  const float f = 2.2;
  vec3 ro = vec3(0.0, 0.0, -f);
  vec3 rd = vec3(s, f);
  vec3 n = cross(U, V);
  float denom = dot(rd, n);
  local = vec2(0.0); t = 0.0; facing = 0.0;
  if (abs(denom) < 1e-5) return false;
  t = dot(p0 - ro, n) / denom;
  if (t <= 0.0) return false;
  vec3 rel = ro + rd * t - p0;
  local = vec2(dot(rel, U), dot(rel, V));
  facing = abs(denom) / length(rd);
  return true;
}

vec4 voronoi(vec2 x) {
  vec2 n = floor(x), f = fract(x), mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + hash22(n + g) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 r = g + hash22(n + g) - f;
    if (dot(mr - r, mr - r) > 1e-5) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return vec4(md, n + mg, 0.0);
}

vec4 hexCell(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hc.xy) : vec4(h.zw, hc.zw + 0.5);
}
float hexDist(vec2 p) { p = abs(p); return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x); }

float sobelA(vec2 uv) {
  vec2 e = 1.5 / uRes;
  float tl = luma(A(uv + vec2(-e.x, -e.y))), t = luma(A(uv + vec2(0.0, -e.y))), tr = luma(A(uv + vec2(e.x, -e.y)));
  float l = luma(A(uv + vec2(-e.x, 0.0))), r = luma(A(uv + vec2(e.x, 0.0)));
  float bl = luma(A(uv + vec2(-e.x, e.y))), b = luma(A(uv + vec2(0.0, e.y))), br = luma(A(uv + vec2(e.x, e.y)));
  return length(vec2(tr + 2.0 * r + br - tl - 2.0 * l - bl, bl + 2.0 * b + br - tl - 2.0 * t - tr));
}
float sobelB(vec2 uv) {
  vec2 e = 1.5 / uRes;
  float tl = luma(B(uv + vec2(-e.x, -e.y))), t = luma(B(uv + vec2(0.0, -e.y))), tr = luma(B(uv + vec2(e.x, -e.y)));
  float l = luma(B(uv + vec2(-e.x, 0.0))), r = luma(B(uv + vec2(e.x, 0.0)));
  float bl = luma(B(uv + vec2(-e.x, e.y))), b = luma(B(uv + vec2(0.0, e.y))), br = luma(B(uv + vec2(e.x, e.y)));
  return length(vec2(tr + 2.0 * r + br - tl - 2.0 * l - bl, bl + 2.0 * b + br - tl - 2.0 * t - tr));
}

// ---- modern transitions -------------------------------------------------------------------

vec3 tFadeWhite(vec2 uv, float p) {
  vec3 c = p < 0.5 ? mix(A(uv) * (1.0 + 1.5 * p), vec3(1.0), ease(p * 2.0)) : mix(vec3(1.0), B(uv), ease(p * 2.0 - 1.0));
  return c;
}

vec3 tSweep(vec2 uv, float p) {
  vec2 dir = normalize(vec2(uDir.x >= 0.0 ? 1.0 : -1.0, -0.4));
  vec2 q = (uv - 0.5) * vec2(aspectRatio(), 1.0);
  float x = dot(q, dir) / (abs(dir.x) * aspectRatio() + abs(dir.y)) + 0.5;
  float d = x - mix(-0.25, 1.25, inOutCubic(p));
  vec3 base = d < 0.0 ? B(uv) : A(uv);
  float band = exp(-d * d * 220.0), halo = exp(-d * d * 16.0);
  return base * (1.0 + 0.3 * halo) + vec3(1.0, 0.95, 0.86) * (band * 1.2 + halo * 0.15);
}

vec3 tBokeh(vec2 uv, float p) {
  float s = sin(p * PI);
  vec3 c = mix(blurA(uv, s * 3.5), blurB(uv, s * 3.5), ease((p - 0.25) / 0.5));
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec3 lights = vec3(0.0);
  for (int i = 0; i < 18; i++) {
    float fi = float(i);
    vec2 center = hash22(vec2(fi, uSeed * 31.0)) + vec2(0.0, -0.12 * p);
    float r = mix(0.03, 0.11, hash12(vec2(fi * 3.1, uSeed * 7.0)));
    float d = length((uv - center) * asp);
    float disc = (1.0 - smoothstep(r * 0.86, r, d)) * (0.6 + 0.4 * smoothstep(r * 0.5, r, d));
    vec3 tint = mix(vec3(1.0, 0.74, 0.42), vec3(0.72, 0.84, 1.0), hash12(vec2(fi, 7.0)));
    lights += tint * disc * 0.32;
  }
  return c + lights * s;
}

vec3 tSlide(vec2 uv, float p) {
  float e = inOutCubic(p);
  vec2 qb = uv + uDir * (1.0 - e);
  if (inside(qb)) return B(qb);
  float out_ = uDir.x > 0.5 ? qb.x - 1.0 : uDir.x < -0.5 ? -qb.x : uDir.y > 0.5 ? qb.y - 1.0 : -qb.y;
  float shadow = exp(-max(out_, 0.0) * 22.0) * 0.6;
  return As(uv - uDir * e * 0.3) * (1.0 - 0.45 * e) * (1.0 - shadow);
}

vec3 tDrop(vec2 uv, float p) {
  float t = clamp(p * 1.15, 0.0, 1.0);
  vec2 qb = uv + vec2(0.0, 1.0 - outBounce(t));
  if (inside(qb)) return B(qb);
  float shadow = exp(-(qb.y - 1.0) * 26.0) * 0.55;
  return A(uv) * (1.0 - 0.35 * t) * (1.0 - shadow);
}

vec3 tZoomSpin(vec2 uv, float p) {
  float s = sin(p * PI);
  float sgn = uDir.x >= 0.0 ? 1.0 : -1.0;
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 d = (uv - 0.5) * asp;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float t = clamp(p + (float(i) / 11.0 - 0.5) * 0.09 * s, 0.0, 1.0);
    if (t < 0.5) {
      float k = ease(t * 2.0);
      sum += As((rot(sgn * k * 1.2) * d) / (1.0 + 2.5 * k * k) / asp + 0.5);
    } else {
      float k = 1.0 - ease(t * 2.0 - 1.0);
      sum += Bs((rot(-sgn * k * 1.2) * d) / (1.0 + 2.5 * k * k) / asp + 0.5);
    }
  }
  return sum / 12.0;
}

vec3 tHyperspace(vec2 uv, float p) {
  float s = sin(p * PI);
  vec2 d = uv - 0.5;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 20; i++) {
    vec2 q = 0.5 + d * (1.0 - 0.6 * s * s * float(i) / 19.0);
    sum += p < 0.5 ? A(q) : B(q);
  }
  vec3 c = sum / 20.0;
  float rays = pow(hash12(vec2(floor(atan(d.y, d.x) * 90.0), uSeed * 50.0)), 6.0);
  float r = length(d * vec2(aspectRatio(), 1.0));
  c += vec3(0.75, 0.86, 1.0) * rays * s * smoothstep(0.05, 0.6, r) * 1.2;
  return c + vec3(1.0) * exp(-pow((p - 0.5) * 9.0, 2.0)) * 0.9;
}

vec3 tCube(vec2 uv, float p) {
  float e = inOutCubic(p);
  float sgn = uDir.x >= 0.0 ? 1.0 : -1.0;
  vec2 s = (uv - 0.5) * 2.0 * (1.0 + 0.45 * sin(p * PI));
  float a = -sgn * e * PI * 0.5;
  vec3 c = vec3(0.0, 0.0, 1.0);
  vec2 la, lb; float ta, tb, fa, fb;
  bool ha = hitPlane(s, c + rotY(vec3(0.0, 0.0, -1.0), a), rotY(vec3(1.0, 0.0, 0.0), a), vec3(0.0, 1.0, 0.0), la, ta, fa) && abs(la.x) <= 1.0 && abs(la.y) <= 1.0;
  bool hb = hitPlane(s, c + rotY(vec3(sgn, 0.0, 0.0), a), rotY(vec3(0.0, 0.0, sgn), a), vec3(0.0, 1.0, 0.0), lb, tb, fb) && abs(lb.x) <= 1.0 && abs(lb.y) <= 1.0;
  if (ha && (!hb || ta < tb)) return A(la * 0.5 + 0.5) * (0.45 + 0.55 * fa);
  if (hb) return B(lb * 0.5 + 0.5) * (0.45 + 0.55 * fb);
  return vec3(0.02);
}

vec3 tFlip(vec2 uv, float p) {
  vec2 s = (uv - 0.5) * 2.0 * (1.0 + 0.35 * sin(p * PI));
  float theta = inOutCubic(p) * PI;
  bool first = theta < PI * 0.5;
  float a = first ? theta : theta - PI;
  vec2 l; float t, f;
  if (hitPlane(s, vec3(0.0), vec3(cos(a), 0.0, sin(a)), vec3(0.0, 1.0, 0.0), l, t, f) && abs(l.x) <= 1.0 && abs(l.y) <= 1.0) {
    vec3 c = first ? A(l * 0.5 + 0.5) : B(l * 0.5 + 0.5);
    return c * (0.4 + 0.6 * f);
  }
  return vec3(0.02);
}

vec3 tFold(vec2 uv, float p) {
  float e = inOutCubic(p);
  float sgn = uDir.x >= 0.0 ? 1.0 : -1.0;
  float x = sgn > 0.0 ? uv.x : 1.0 - uv.x;
  float w = 1.0 - e;
  if (x > w) return B(uv) * (0.6 + 0.4 * e);
  const float panels = 6.0;
  float u = x / max(w, 1e-4) * panels;
  float i = floor(u), f = fract(u);
  float src = (i + f) / panels;
  float shade = mod(i, 2.0) < 1.0 ? 1.0 - 0.55 * e * f : 1.0 - 0.55 * e * (1.0 - f);
  vec2 q = vec2(sgn > 0.0 ? src : 1.0 - src, uv.y);
  return A(q) * shade;
}

vec3 tDoors(vec2 uv, float p) {
  float e = inOutCubic(p);
  vec2 s = (uv - 0.5) * 2.0;
  float open = e * 1.65;
  vec2 ll, lr; float tl, tr, fl, fr;
  bool hl = hitPlane(s, vec3(-1.0, 0.0, 0.0), rotY(vec3(1.0, 0.0, 0.0), -open), vec3(0.0, 1.0, 0.0), ll, tl, fl) && ll.x >= 0.0 && ll.x <= 1.0 && abs(ll.y) <= 1.0;
  bool hr = hitPlane(s, vec3(1.0, 0.0, 0.0), rotY(vec3(-1.0, 0.0, 0.0), open), vec3(0.0, 1.0, 0.0), lr, tr, fr) && lr.x >= 0.0 && lr.x <= 1.0 && abs(lr.y) <= 1.0;
  if (hl && (!hr || tl < tr)) return A(vec2(ll.x * 0.5, ll.y * 0.5 + 0.5)) * (0.4 + 0.6 * fl);
  if (hr) return A(vec2(1.0 - lr.x * 0.5, lr.y * 0.5 + 0.5)) * (0.4 + 0.6 * fr);
  return B((uv - 0.5) / (0.85 + 0.15 * e) + 0.5) * (0.45 + 0.55 * e);
}

vec3 tTiles(vec2 uv, float p) {
  vec2 grid = vec2(7.0, 4.0);
  vec2 cell = floor(uv * grid);
  vec2 local = fract(uv * grid);
  float delay = (cell.x + cell.y) / (grid.x + grid.y - 2.0) * 0.5;
  float t = clamp((p - delay) / 0.5, 0.0, 1.0);
  float scale = cos(ease(t) * PI);
  float w = abs(scale) * 0.5;
  if (abs(local.x - 0.5) > w) return vec3(0.02);
  vec2 src = (cell + vec2(0.5 + (local.x - 0.5) / max(abs(scale), 1e-3) * sign(scale), local.y)) / grid;
  vec3 c = scale > 0.0 ? A(src) : B((cell + vec2(0.5 - (local.x - 0.5) / max(abs(scale), 1e-3) * sign(scale), local.y)) / grid);
  return c * (0.45 + 0.55 * abs(scale));
}

vec3 tCards(vec2 uv, float p) {
  float sgn = uDir.x >= 0.0 ? 1.0 : -1.0;
  float shrink = ease(p / 0.35);
  float fly = clamp((p - 0.25) / 0.75, 0.0, 1.0);
  fly = fly * fly * fly;
  float scale = 1.0 - 0.14 * shrink;
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 d = (uv - 0.5 - vec2(sgn * fly * 1.4, -fly * 0.25)) * asp;
  vec2 local = (rot(-sgn * fly * 0.5) * d) / asp / scale + 0.5;
  float radius = 0.03 * shrink;
  vec2 qd = abs(local - 0.5) * asp - (0.5 * asp - radius);
  float sdf = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0) - radius;
  float card = 1.0 - smoothstep(-0.002, 0.002, sdf);
  float bs = 0.94 + 0.06 * ease(p);
  vec3 under = B((uv - 0.5) / bs + 0.5) * (0.55 + 0.45 * ease(p));
  under *= 1.0 - (1.0 - smoothstep(0.0, 0.07, sdf)) * 0.55 * shrink * (1.0 - fly);
  return mix(under, A(clamp(local, 0.0, 1.0)), card);
}

vec3 tLiquid(vec2 uv, float p) {
  float s = sin(p * PI);
  vec2 n = vec2(fbm(uv * 3.0 + vec2(uSeed * 7.0, p * 1.5)), fbm(uv * 3.0 + vec2(5.2, uSeed * 3.0 - p * 1.5))) - 0.5;
  vec2 off = n * 0.24 * s;
  return mix(A(uv + off), B(uv - off), ease((p - 0.2) / 0.6 + n.x * 0.7 * s));
}

vec3 tSwirl(vec2 uv, float p) {
  float s = sin(p * PI);
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 d = (uv - 0.5) * asp;
  float twist = s * 6.0 * pow(max(0.0, 1.0 - length(d) / 0.95), 2.0) * (uDir.x >= 0.0 ? 1.0 : -1.0);
  vec2 q = (rot(twist) * d) / asp + 0.5;
  return mix(A(q), B(q), ease((p - 0.3) / 0.4));
}

vec3 tMorph(vec2 uv, float p) {
  float lod = 3.0;
  vec2 px = exp2(lod) / uRes;
  vec2 ga = vec2(luma(textureLod(uA, flipY(uv + vec2(px.x, 0.0)), lod).rgb) - luma(textureLod(uA, flipY(uv - vec2(px.x, 0.0)), lod).rgb),
                 luma(textureLod(uA, flipY(uv + vec2(0.0, px.y)), lod).rgb) - luma(textureLod(uA, flipY(uv - vec2(0.0, px.y)), lod).rgb));
  vec2 gb = vec2(luma(textureLod(uB, flipY(uv + vec2(px.x, 0.0)), lod).rgb) - luma(textureLod(uB, flipY(uv - vec2(px.x, 0.0)), lod).rgb),
                 luma(textureLod(uB, flipY(uv + vec2(0.0, px.y)), lod).rgb) - luma(textureLod(uB, flipY(uv - vec2(0.0, px.y)), lod).rgb));
  return mix(A(uv + gb * p * 0.18), B(uv - ga * (1.0 - p) * 0.18), ease(p));
}

vec3 tWave(vec2 uv, float p) {
  float sgn = uDir.x >= 0.0 ? 1.0 : -1.0;
  float x = sgn > 0.0 ? uv.x : 1.0 - uv.x;
  float edge = mix(-0.15, 1.15, inOutCubic(p)) + sin(uv.y * 14.0 + p * 10.0 + uSeed * 6.0) * 0.05 + sin(uv.y * 31.0 - p * 7.0) * 0.015;
  float d = x - edge;
  vec2 refr = vec2(exp(-d * d * 300.0) * 0.02 * sgn, 0.0);
  return mix(B(uv + refr), A(uv - refr), smoothstep(-0.02, 0.02, d)) + vec3(1.0) * exp(-d * d * 2000.0) * 0.25;
}

vec3 tKaleido(vec2 uv, float p) {
  float s = sin(p * PI);
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 d = (uv - 0.5) * asp;
  float seg = PI / 3.0;
  float a = mod(atan(d.y, d.x) + p * 1.5, seg);
  a = abs(a - seg * 0.5);
  vec2 k = vec2(cos(a), sin(a)) * length(d) / asp + 0.5;
  vec2 q = mix(uv, k, smoothstep(0.0, 0.35, s));
  return mix(A(q), B(q), ease((p - 0.35) / 0.3));
}

vec3 tBulge(vec2 uv, float p) {
  float s = sin(p * PI);
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 d = (uv - 0.5) * asp;
  float k = 1.0 - s * 0.55 * (1.0 - smoothstep(0.0, 0.9, length(d)));
  vec2 q = d * k / asp + 0.5;
  return mix(A(q), B(q), ease((p - 0.35) / 0.3)) * (1.0 + 0.15 * s);
}

vec3 tPixelate(vec2 uv, float p) {
  float s = sin(p * PI);
  if (s < 0.02) return p < 0.5 ? A(uv) : B(uv);
  float cells = mix(uRes.y * 0.5, 10.0, pow(s, 0.5));
  vec2 grid = vec2(cells * aspectRatio(), cells);
  vec2 q = (floor(uv * grid) + 0.5) / grid;
  return mix(A(q), B(q), smoothstep(0.45, 0.55, p));
}

vec3 tChromatic(vec2 uv, float p) {
  float s = sin(p * PI);
  float m = ease((p - 0.3) / 0.4);
  vec2 d = uv - 0.5;
  vec2 qr = 0.5 + d / (1.0 + 0.11 * s), qg = 0.5 + d / (1.0 + 0.02 * s), qb = 0.5 + d / (1.0 - 0.08 * s);
  vec3 c = vec3(mix(A(qr), B(qr), m).r, mix(A(qg), B(qg), m).g, mix(A(qb), B(qb), m).b);
  return c * (1.0 + 0.2 * s);
}

vec3 tDatamosh(vec2 uv, float p) {
  float s = sin(p * PI);
  vec2 blocks = vec2(24.0 * aspectRatio(), 24.0);
  vec2 cell = floor(uv * blocks);
  vec2 mv = (hash22(cell + floor(p * 12.0) + uSeed * 9.0) - 0.5) * 0.14 * s;
  float moving = step(0.45, hash12(cell + 3.0));
  float switched = step(hash12(cell * 1.7 + uSeed), p * 1.3 - 0.15);
  vec2 q = uv + mv * moving;
  vec3 c = mix(A(q), B(q + mv * 0.5), switched);
  return mix(c, floor(c * 18.0) / 18.0, s * 0.6);
}

vec3 tVhs(vec2 uv, float p) {
  float s = sin(p * PI);
  float roll = s * s * 0.4 * (p < 0.5 ? 1.0 : -1.0);
  float y = fract(uv.y + roll);
  float jitter = (hash12(vec2(floor(uv.y * uRes.y / 2.0), floor(p * 60.0))) - 0.5) * 0.02 * s;
  float band = step(0.97, fract(uv.y * 2.0 + p * 3.0)) * s;
  vec2 q = vec2(uv.x + jitter + band * 0.04, y);
  float shift = 0.006 * s;
  vec3 c = p < 0.5 ? vec3(A(q + vec2(shift, 0.0)).r, A(q).g, A(q - vec2(shift, 0.0)).b)
                   : vec3(B(q + vec2(shift, 0.0)).r, B(q).g, B(q - vec2(shift, 0.0)).b);
  c += (hash12(uv * uRes + floor(p * 60.0)) - 0.5) * 0.22 * s;
  c *= 1.0 - 0.22 * s * step(0.5, fract(uv.y * uRes.y / 2.0));
  return c * (1.0 - smoothstep(0.0, 0.015, 0.015 - min(y, 1.0 - y)) * s);
}

vec3 tNeon(vec2 uv, float p) {
  vec3 cyan = vec3(0.1, 0.9, 1.0), pink = vec3(1.0, 0.2, 0.8);
  if (p < 0.5) {
    float e = clamp(sobelA(uv) * 1.6, 0.0, 1.0);
    vec3 neon = mix(cyan, pink, uv.x) * e * 1.8 + A(uv) * 0.05;
    return mix(A(uv), neon, ease(p * 2.0));
  }
  float e = clamp(sobelB(uv) * 1.6, 0.0, 1.0);
  vec3 neon = mix(pink, cyan, uv.x) * e * 1.8 + B(uv) * 0.05;
  return mix(neon, B(uv), ease(p * 2.0 - 1.0));
}

vec3 tHalftone(vec2 uv, float p) {
  const float cell = 22.0;
  vec2 rotated = rot(0.785) * (uv * uRes);
  vec2 id = floor(rotated / cell);
  vec2 f = fract(rotated / cell) - 0.5;
  vec2 centre = (rot(-0.785) * ((id + 0.5) * cell)) / uRes;
  float r = clamp(p * 1.5 - 0.25 + (luma(B(centre)) - 0.5) * 0.4, 0.0, 1.0) * 0.76;
  return mix(A(uv), B(uv), 1.0 - smoothstep(r - 0.04, r + 0.04, length(f)));
}

vec3 tHexagon(vec2 uv, float p) {
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 q = (uv - 0.5) * asp * 9.0;
  vec4 h = hexCell(q);
  vec2 centre = q - h.xy;
  float delay = length(centre) / (4.5 * length(asp)) * 0.55 + hash12(h.zw + uSeed) * 0.05;
  float t = clamp((p - delay) / 0.4, 0.0, 1.0);
  float size = ease(t) * 0.62;
  float d = hexDist(h.xy);
  vec3 c = mix(A(uv), B(uv), 1.0 - smoothstep(size - 0.03, size, d));
  float running = step(0.001, t) * step(t, 0.999);
  return c + vec3(1.0, 0.85, 0.5) * (1.0 - smoothstep(0.0, 0.03, abs(d - size))) * 0.4 * running;
}

vec3 tDots(vec2 uv, float p) {
  const float n = 14.0;
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 g = uv * asp * n;
  vec2 f = fract(g) - 0.5;
  vec2 centre = (floor(g) + 0.5) / n / asp;
  float x = uDir.x >= 0.0 ? centre.x : 1.0 - centre.x;
  float delay = (x * 0.5 + centre.y * 0.2) / 0.7 * 0.6;
  float t = clamp((p - delay) / 0.4, 0.0, 1.0);
  float r = ease(t) * 0.75;
  return mix(A(uv), B(uv), 1.0 - smoothstep(r - 0.03, r + 0.03, length(f)));
}

vec3 tIris(vec2 uv, float p) {
  vec2 o = vec2(0.3 + 0.4 * fract(uSeed * 5.3), 0.3 + 0.4 * fract(uSeed * 9.7));
  vec2 asp = vec2(aspectRatio(), 1.0);
  float maxR = length(max(o, 1.0 - o) * asp);
  float r = inOutCubic(p) * maxR * 1.08 - 0.05;
  float d = length((uv - o) * asp);
  vec3 c = mix(A(uv) * (1.0 - 0.3 * ease(p)), B(uv), 1.0 - smoothstep(r - 0.04, r + 0.01, d));
  return c + vec3(1.0, 0.9, 0.75) * exp(-pow((d - r) * 60.0, 2.0)) * 0.35 * sin(p * PI);
}

vec3 tClock(vec2 uv, float p) {
  vec2 d = (uv - 0.5) * vec2(aspectRatio(), 1.0);
  float a = fract(atan(d.x, -d.y) / (2.0 * PI));
  if (uDir.x < 0.0) a = 1.0 - a;
  float t = inOutCubic(p) * 1.04;
  return mix(A(uv), B(uv), 1.0 - smoothstep(t - 0.02, t, a));
}

vec3 tSlices(vec2 uv, float p) {
  const float n = 9.0;
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 dir = normalize(vec2(1.0, 0.35));
  float idx = floor(dot((uv - 0.5) * asp, vec2(-dir.y, dir.x)) * n + 100.0);
  float alt = mod(idx, 2.0) < 1.0 ? 1.0 : -1.0;
  float t = inOutCubic(clamp((p - fract(idx * 0.37) * 0.3) / 0.7, 0.0, 1.0));
  vec2 qb = uv + dir / asp * alt * (1.0 - t) * 2.5;
  return t > 0.0 && inside(qb) ? B(qb) : A(uv) * (1.0 - 0.3 * t);
}

vec3 tShatter(vec2 uv, float p) {
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec4 v = voronoi(uv * asp * 6.0 + uSeed * 10.0);
  vec2 id = v.yz;
  float t = clamp((p - hash12(id) * 0.45) / 0.55, 0.0, 1.0);
  vec2 fall = ((hash22(id * 1.3) - 0.5) * vec2(0.3, 0.1) + vec2(0.0, 0.5)) * t * t;
  float gone = smoothstep(0.5, 0.9, t);
  vec3 c = mix(A(uv - fall) * (1.0 - 0.4 * t), B(uv), gone);
  float crack = 1.0 - smoothstep(0.0, 0.025, v.x);
  return c + vec3(0.9, 0.95, 1.0) * crack * sin(clamp(p * 4.0, 0.0, PI)) * 0.6 * (1.0 - gone);
}

vec3 tInk(vec2 uv, float p) {
  vec2 asp = vec2(aspectRatio(), 1.0);
  float n = fbm(uv * asp * 3.0 + uSeed * 20.0) * 0.6 + fbm(uv * asp * 14.0 + 3.0) * 0.12;
  vec2 o = 0.5 + (vec2(fract(uSeed * 3.1), fract(uSeed * 7.9)) - 0.5) * 0.5;
  float d = length((uv - o) * asp) * 0.7 + n - mix(0.0, 1.7, inOutCubic(p));
  vec3 c = mix(B(uv), A(uv), smoothstep(-0.01, 0.01, d));
  return c * (1.0 - 0.75 * exp(-abs(d) * 45.0));
}

vec3 tSmoke(vec2 uv, float p) {
  float s = sin(p * PI);
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 drift = vec2(0.0, -p * 0.6);
  float n = fbm(uv * asp * 2.2 + drift + uSeed * 9.0) * 0.7 + fbm(uv * asp * 5.0 - drift * 1.7) * 0.3;
  float th = mix(-0.25, 1.25, ease(p));
  float m = smoothstep(th - 0.18, th + 0.18, n);
  vec3 c = mix(blurB(uv, (1.0 - ease(p)) * 2.0 * s), blurA(uv + vec2(0.0, -0.02 * s), s * 2.0), m);
  return c + vec3(0.85) * (1.0 - abs(m - 0.5) * 2.0) * 0.18 * s;
}

vec3 tDust(vec2 uv, float p) {
  float sgn = uDir.x >= 0.0 ? 1.0 : -1.0;
  float th = mix(-0.05, 1.05, p);
  float grain = hash12(floor(uv * uRes / 2.0));
  float field = (sgn > 0.0 ? uv.x : 1.0 - uv.x) * 0.75 + grain * 0.25;
  vec3 c = field < th ? B(uv) : A(uv);
  vec2 wind = vec2(sgn, -0.6) * 0.18;
  for (int i = 1; i <= 8; i++) {
    float k = float(i) / 8.0;
    vec2 src = uv - wind * k;
    float g = hash12(floor(src * uRes / 2.0));
    float f = (sgn > 0.0 ? src.x : 1.0 - src.x) * 0.75 + g * 0.25;
    float age = th - f;
    if (g > 0.55 && age > 0.0 && abs(age * 2.2 - k) < 0.07 && inside(src)) {
      c = mix(c, A(src) * 1.15, (1.0 - k) * 0.9);
      break;
    }
  }
  return c;
}

vec3 transition(vec2 uv) {
  float p = clamp(uP, 0.0, 1.0);
  float aspect = uRes.x / uRes.y;
  if (uKind == 0) { // dissolve
    return mix(A(uv), B(uv), ease(p));
  }
  if (uKind == 1) { // dip to black
    return A(uv) * (1.0 - ease(p * 2.0)) + B(uv) * ease(p * 2.0 - 1.0);
  }
  if (uKind == 2) { // blur dissolve
    float lod = sin(p * PI) * 5.5;
    vec3 c = mix(blurA(uv, lod), blurB(uv, lod), ease((p - 0.2) / 0.6));
    return c * (1.0 + 0.1 * sin(p * PI));
  }
  if (uKind == 3) { // light leak
    vec3 base = mix(A(uv), B(uv), ease((p - 0.3) / 0.4));
    float s = sin(p * PI);
    float travel = uDir.x >= 0.0 ? p : 1.0 - p;
    vec2 center = vec2(mix(-0.35, 1.35, travel), 0.3 + 0.3 * fract(uSeed * 7.13));
    vec2 d = (uv - center) * vec2(aspect * 0.55, 1.0);
    float n = fbm(uv * vec2(2.2, 1.6) + vec2(uSeed * 11.0, p * 0.9));
    float glow = exp(-dot(d, d) * 2.4) * (0.45 + 0.95 * n);
    vec3 tint = mix(vec3(1.0, 0.32, 0.06), vec3(1.0, 0.8, 0.48), clamp(glow * 1.2, 0.0, 1.0));
    vec3 light = clamp(tint * glow * s * 1.7 + vec3(1.0, 0.86, 0.68) * s * s * 0.22, 0.0, 1.0);
    return 1.0 - (1.0 - base) * (1.0 - light);
  }
  if (uKind == 4) { // cross zoom
    float s = sin(p * PI);
    vec2 center = vec2(0.5) + (vec2(fract(uSeed * 13.1), fract(uSeed * 7.7)) - 0.5) * 0.25;
    vec2 toCenter = center - uv;
    float jitter = hash12(uv * uRes + uSeed * 100.0);
    float mixer = ease((p - 0.35) / 0.3);
    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i <= 24; i++) {
      float t = (float(i) + jitter) / 24.0;
      float w = 4.0 * (t - t * t);
      vec2 q = uv + toCenter * t * 0.4 * s;
      sum += mix(A(q), B(q), mixer) * w;
      total += w;
    }
    return sum / total * (1.0 + 0.3 * s * s);
  }
  if (uKind == 5) { // push through
    float e = ease(p);
    float s = sin(p * PI);
    vec2 ua = (uv - 0.5) / (1.0 + 0.4 * e) + 0.5;
    vec2 ub = (uv - 0.5) / (1.18 - 0.18 * e) + 0.5;
    vec2 dir = (uv - 0.5) * 0.035 * s;
    vec3 a = vec3(0.0), b = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float k = float(i) / 7.0 - 0.5;
      a += A(ua + dir * k);
      b += B(ub + dir * k);
    }
    return mix(a, b, ease((p - 0.25) / 0.5)) / 8.0;
  }
  if (uKind == 6) { // soft wipe
    vec2 dir = normalize(uDir);
    vec2 q = (uv - 0.5) * vec2(aspect, 1.0);
    float extent = 0.5 * (abs(dir.x) * aspect + abs(dir.y));
    float x = dot(q, dir) / (2.0 * extent) + 0.5;
    float width = 0.35;
    float t = ease(p) * (1.0 + width);
    return mix(B(uv), A(uv), smoothstep(t - width, t, x));
  }
  if (uKind == 7) { // whip pan: both frames slide along uDir with motion blur
    float e = p < 0.5 ? 4.0 * p * p * p : 1.0 - pow(-2.0 * p + 2.0, 3.0) / 2.0;
    float speed = 3.0 * pow(1.0 - abs(2.0 * p - 1.0), 2.0);
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 20; i++) {
      float o = (float(i) / 19.0 - 0.5) * speed * 0.09;
      vec2 q = uv + uDir * (e + o);
      bool inA = q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0;
      sum += inA ? A(q) : B(q - uDir);
    }
    return sum / 20.0;
  }
  if (uKind == 8) { // flash: the cut hides inside a burst of white light
    float f = exp(-pow((p - 0.5) * 6.0, 2.0));
    vec2 q = (uv - 0.5) / (1.0 + 0.06 * f) + 0.5;
    vec3 c = p < 0.5 ? A(q) : B(q);
    return c * (1.0 + 2.2 * f) + vec3(1.0, 0.96, 0.9) * f * 0.85;
  }
  if (uKind == 9) { // glitch: torn scanlines, RGB split and blocks flipping to the next frame
    float s = sin(p * PI);
    float frame = floor(p * 30.0);
    float rows = mix(14.0, 46.0, fract(uSeed * 3.7));
    float r = hash12(vec2(floor(uv.y * rows), frame + uSeed * 97.0));
    vec2 q = vec2(uv.x + (r - 0.5) * 0.3 * s * step(0.6, r), uv.y);
    float useB = step(hash12(floor(vec2(q.x * 12.0, uv.y * rows * 0.5)) + uSeed * 31.0), p * 1.4 - 0.2);
    float split = 0.018 * s;
    vec3 a = vec3(A(q + vec2(split, 0.0)).r, A(q).g, A(q - vec2(split, 0.0)).b);
    vec3 b = vec3(B(q + vec2(split, 0.0)).r, B(q).g, B(q - vec2(split, 0.0)).b);
    vec3 c = mix(a, b, useB);
    c *= 1.0 - 0.18 * s * step(0.5, fract(uv.y * uRes.y / 3.0));
    return c + vec3(0.15, 0.05, 0.2) * s * step(0.92, r);
  }
  if (uKind == 10) { // zoom punch: rush into the outgoing frame, slam out of the incoming one
    float k = p < 0.5 ? p * 2.0 : (1.0 - p) * 2.0;
    float scale = 1.0 + 1.6 * k * k * k;
    float streak = 0.12 * k * k;
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      vec2 q = 0.5 + (uv - 0.5) / (scale * (1.0 + streak * float(i) / 11.0));
      sum += p < 0.5 ? A(q) : B(q);
    }
    return sum / 12.0 + vec3(1.0) * exp(-pow((p - 0.5) * 14.0, 2.0)) * 0.7;
  }
  if (uKind == 11) { // spin: rotate out with motion blur, rotate the next frame in
    float s = sin(p * PI);
    float sgn = uDir.x >= 0.0 ? 1.0 : -1.0;
    float angle = sgn * (p < 0.5 ? 4.0 * p * p : -4.0 * (1.0 - p) * (1.0 - p)) * 0.9;
    float arc = sgn * 3.6 * (p < 0.5 ? p : 1.0 - p) * 0.06;
    vec2 stretch = vec2(aspect, 1.0);
    vec2 d = (uv - 0.5) * stretch;
    float zoom = 1.0 + 0.6 * s;
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 14; i++) {
      float a = angle - arc * float(i) / 13.0;
      vec2 q = (mat2(cos(a), sin(a), -sin(a), cos(a)) * d) / zoom / stretch + 0.5;
      sum += p < 0.5 ? A(q) : B(q);
    }
    return sum / 14.0;
  }
  if (uKind == 12) { // shutter: staggered slats sweep the next frame in
    float coord = abs(uDir.y) > 0.5 ? uv.x : uv.y;
    float slats = 8.0;
    float local = fract(coord * slats);
    float t = ease(clamp(p * 1.5 - floor(coord * slats) / slats * 0.5, 0.0, 1.0));
    vec3 c = mix(A(uv), B(uv), smoothstep(local - 0.04, local + 0.04, t));
    float seam = (1.0 - smoothstep(0.0, 0.05, abs(local - t))) * step(0.001, t) * step(t, 0.999);
    return c * (1.0 - 0.35 * seam);
  }
  if (uKind == 13) { // ripple: concentric waves carry a dissolve
    float s = sin(p * PI);
    vec2 stretch = vec2(aspect, 1.0);
    vec2 d = (uv - 0.5) * stretch;
    float dist = length(d);
    vec2 offset = d / max(dist, 1e-4) * sin(dist * 38.0 - p * 18.0) * 0.022 * s / stretch;
    return mix(A(uv + offset), B(uv + offset), ease((p - 0.15) / 0.7));
  }
  if (uKind == 14) { // film burn: a glowing hole eats through the frame
    vec2 origin = vec2(fract(uSeed * 5.3), fract(uSeed * 9.1));
    float field = fbm(uv * vec2(aspect, 1.0) * 2.6 + uSeed * 13.0) * 0.55 + length((uv - origin) * vec2(aspect, 1.0)) * 0.45;
    float d = field - mix(-0.35, 1.55, p);
    vec3 c = mix(B(uv), A(uv), smoothstep(-0.015, 0.015, d));
    float front = step(0.0, d);
    c *= 1.0 - 0.6 * exp(-max(d, 0.0) * 9.0) * front;
    c += vec3(1.0, 0.42, 0.08) * exp(-max(d, 0.0) * 40.0) * front * 1.8;
    return c + vec3(1.0, 0.85, 0.5) * exp(-abs(d) * 120.0) * 1.2;
  }
  if (uKind == 15) { // luma fade: the incoming photo's highlights arrive first
    vec3 b = B(uv);
    float t = mix(-0.25, 1.25, ease(p));
    return mix(A(uv), b, smoothstep(0.75 - t, 1.25 - t, luma(b)));
  }
  if (uKind == 16) return tFadeWhite(uv, p);
  if (uKind == 17) return tSweep(uv, p);
  if (uKind == 18) return tBokeh(uv, p);
  if (uKind == 19) return tSlide(uv, p);
  if (uKind == 20) return tDrop(uv, p);
  if (uKind == 21) return tZoomSpin(uv, p);
  if (uKind == 22) return tHyperspace(uv, p);
  if (uKind == 23) return tCube(uv, p);
  if (uKind == 24) return tFlip(uv, p);
  if (uKind == 25) return tFold(uv, p);
  if (uKind == 26) return tDoors(uv, p);
  if (uKind == 27) return tTiles(uv, p);
  if (uKind == 28) return tCards(uv, p);
  if (uKind == 29) return tLiquid(uv, p);
  if (uKind == 30) return tSwirl(uv, p);
  if (uKind == 31) return tMorph(uv, p);
  if (uKind == 32) return tWave(uv, p);
  if (uKind == 33) return tKaleido(uv, p);
  if (uKind == 34) return tBulge(uv, p);
  if (uKind == 35) return tPixelate(uv, p);
  if (uKind == 36) return tChromatic(uv, p);
  if (uKind == 37) return tDatamosh(uv, p);
  if (uKind == 38) return tVhs(uv, p);
  if (uKind == 39) return tNeon(uv, p);
  if (uKind == 40) return tHalftone(uv, p);
  if (uKind == 41) return tHexagon(uv, p);
  if (uKind == 42) return tDots(uv, p);
  if (uKind == 43) return tIris(uv, p);
  if (uKind == 44) return tClock(uv, p);
  if (uKind == 45) return tSlices(uv, p);
  if (uKind == 46) return tShatter(uv, p);
  if (uKind == 47) return tInk(uv, p);
  if (uKind == 48) return tSmoke(uv, p);
  if (uKind == 49) return tDust(uv, p);
  return mix(A(uv), B(uv), ease(p));
}

vec3 grade(vec3 c) {
  c = clamp(c * uGain + uLift * (1.0 - c), 0.0, 1.0);
  c = pow(c, 1.0 / uGamma);
  c = mix(vec3(luma(c)), c, uSat);
  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
  float l = luma(c);
  c += uShadowTint * (1.0 - smoothstep(0.0, 0.55, l)) + uHighTint * smoothstep(0.45, 1.0, l);
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec3 c = uKind == -2 ? vec3(0.0) : uKind == -1 ? A(uv) : transition(uv);
  c = grade(c);

  float aspect = uRes.x / uRes.y;
  vec2 q = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(q) / length(vec2(aspect, 1.0) * 0.5);
  c *= 1.0 - uVignette * 0.75 * smoothstep(0.35, 1.1, r);

  // Film grain refreshes at 24 fps and is strongest in the midtones, as on film.
  float frame = floor(uTime * 24.0);
  vec2 px = gl_FragCoord.xy;
  float g = hash12(px + vec2(frame * 173.0, frame * 91.0)) + hash12(px * 1.37 + vec2(frame * 37.0, 11.0)) - 1.0;
  float l = luma(c);
  c += g * uGrain * 0.12 * (0.3 + 0.7 * (1.0 - abs(l - 0.45) * 1.5));

  c *= uFade;
  float y = uv.y * uRes.y;
  float top = uBars * uRes.y;
  c *= clamp(y - top + 0.5, 0.0, 1.0) * clamp(uRes.y - top - y + 0.5, 0.0, 1.0);

  c += (hash12(px + frame * 0.5) - 0.5) / 255.0;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;


/** Offscreen passes run in texture space (no y flip), so outputs keep the slide's orientation. */
const DOWNSAMPLE = `${COMMON}
uniform sampler2D uSrc;
uniform vec2 uSize;
void main() { outColor = vec4(texture(uSrc, gl_FragCoord.xy / uSize).rgb, 1.0); }`;

/** One direction of a separable Gaussian blur. */
const GAUSSIAN = `${COMMON}
uniform sampler2D uSrc;
uniform vec2 uSize;
uniform vec2 uDir;
uniform float uSigma;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = -12; i <= 12; i++) {
    float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
    sum += texture(uSrc, uv + uDir * float(i) / uSize).rgb * w;
    total += w;
  }
  outColor = vec4(sum / total, 1.0);
}`;

/** Transitions that sample blurred (mip) levels of the composed frames. */
export const NEEDS_FRAME_MIPS = new Set([2, 18, 31, 48]);

class GLTexture implements SlideTexture {
  constructor(
    private gl: WebGL2RenderingContext,
    readonly handle: WebGLTexture,
    readonly blur: WebGLTexture,
    readonly width: number,
    readonly height: number,
  ) {}
  dispose() {
    this.gl.deleteTexture(this.handle);
    this.gl.deleteTexture(this.blur);
  }
}

interface Target {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

export class GLRenderer implements Renderer {
  readonly kind = "webgl2";
  readonly maxTextureSize: number;
  private gl: WebGL2RenderingContext;
  private compose: { program: WebGLProgram; u: Uniforms };
  private final: { program: WebGLProgram; u: Uniforms };
  private downsample: { program: WebGLProgram; u: Uniforms };
  private gaussian: { program: WebGLProgram; u: Uniforms };
  private scratchFbo: WebGLFramebuffer;
  private vao: WebGLVertexArrayObject;
  private targets: [Target, Target] | null = null;
  private width = 1;
  private height = 1;
  private anisotropy: { ext: EXT_texture_filter_anisotropic; max: number } | null = null;

  /** Throws if WebGL2 is unavailable, so the caller can fall back to Canvas2D. */
  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const ext = gl.getExtension("EXT_texture_filter_anisotropic");
    if (ext) this.anisotropy = { ext, max: Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) };
    this.vao = gl.createVertexArray()!;
    this.compose = this.program(COMPOSE, ["uImage", "uBlur", "uMode", "uRect", "uRoll", "uAspect", "uBack", "uBand", "uFramePx"]);
    this.downsample = this.program(DOWNSAMPLE, ["uSrc", "uSize"]);
    this.gaussian = this.program(GAUSSIAN, ["uSrc", "uSize", "uDir", "uSigma"]);
    this.scratchFbo = gl.createFramebuffer()!;
    this.final = this.program(FINAL, [
      "uA", "uB", "uKind", "uP", "uDir", "uSeed", "uRes", "uTime", "uFade", "uBars", "uGrain", "uVignette",
      "uLift", "uGamma", "uGain", "uSat", "uContrast", "uShadowTint", "uHighTint",
    ]);
  }

  private program(fragment: string, names: string[]) {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Shader link failed: ${gl.getProgramInfoLog(program)}`);
    const u: Uniforms = {};
    for (const name of names) u[name] = gl.getUniformLocation(program, name);
    return { program, u };
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height && this.targets) return;
    this.width = this.canvas.width = Math.max(1, width);
    this.height = this.canvas.height = Math.max(1, height);
    this.disposeTargets();
    this.targets = [this.createTarget(), this.createTarget()];
  }

  private createTarget(): Target {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, texture };
  }

  upload(image: HTMLImageElement | HTMLCanvasElement): SlideTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.ext.TEXTURE_MAX_ANISOTROPY_EXT, this.anisotropy.max);
    const [w, h] = image instanceof HTMLImageElement ? [image.naturalWidth, image.naturalHeight] : [image.width, image.height];
    return new GLTexture(gl, texture, this.blurred(texture, w / h), w, h);
  }

  private colorTexture(width: number, height: number) {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /**
   * A small, heavily Gaussian-blurred copy of a slide for the frosted backdrop behind fitted
   * photos. Computed once per slide, so drawing it costs a single texture read per pixel.
   */
  private blurred(source: WebGLTexture, aspect: number): WebGLTexture {
    const gl = this.gl;
    const long = 320;
    const w = aspect >= 1 ? long : Math.max(16, Math.round(long * aspect));
    const h = aspect >= 1 ? Math.max(16, Math.round(long / aspect)) : long;
    const a = this.colorTexture(w, h);
    const b = this.colorTexture(w, h);
    const pass = (program: { program: WebGLProgram; u: Uniforms }, from: WebGLTexture, to: WebGLTexture, dir?: [number, number]) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, to, 0);
      gl.useProgram(program.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, from);
      gl.uniform1i(program.u.uSrc, 0);
      gl.uniform2f(program.u.uSize, w, h);
      if (dir) {
        gl.uniform2f(program.u.uDir, dir[0], dir[1]);
        gl.uniform1f(program.u.uSigma, 5.5);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.viewport(0, 0, w, h);
    pass(this.downsample, source, a);
    for (let i = 0; i < 2; i++) {
      pass(this.gaussian, a, b, [1, 0]);
      pass(this.gaussian, b, a, [0, 1]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteTexture(b);
    return a;
  }

  render(state: FrameState) {
    const gl = this.gl;
    if (!this.targets) this.resize(this.width, this.height);
    const [ta, tb] = this.targets!;
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.width, this.height);
    // Only a few transitions read blurred levels of the frames; skip the mip chain otherwise.
    const mips = !!state.b && NEEDS_FRAME_MIPS.has(state.transition);
    if (state.a) this.composeInto(ta, state.a, state.bars, mips);
    if (state.b) this.composeInto(tb, state.b, state.bars, mips);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const { program, u } = this.final;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ta.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.b ? tb.texture : ta.texture);
    gl.uniform1i(u.uA, 0);
    gl.uniform1i(u.uB, 1);
    gl.uniform1i(u.uKind, !state.a ? -2 : state.b ? state.transition : -1);
    gl.uniform1f(u.uP, state.progress);
    gl.uniform2f(u.uDir, state.direction[0], state.direction[1]);
    gl.uniform1f(u.uSeed, state.seed);
    gl.uniform2f(u.uRes, this.width, this.height);
    gl.uniform1f(u.uTime, state.time);
    gl.uniform1f(u.uFade, state.fade);
    gl.uniform1f(u.uBars, state.bars);
    gl.uniform1f(u.uGrain, state.grain);
    gl.uniform1f(u.uVignette, state.vignette);
    const g = state.grade;
    gl.uniform3fv(u.uLift, g.lift);
    gl.uniform3fv(u.uGamma, g.gamma);
    gl.uniform3fv(u.uGain, g.gain);
    gl.uniform1f(u.uSat, g.saturation);
    gl.uniform1f(u.uContrast, g.contrast);
    gl.uniform3fv(u.uShadowTint, g.shadowTint);
    gl.uniform3fv(u.uHighTint, g.highlightTint);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private composeInto(target: Target, frame: SlideFrame, bars: number, mips: boolean) {
    const gl = this.gl;
    const texture = frame.texture as GLTexture;
    const { program, u } = this.compose;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture.handle);
    gl.uniform1i(u.uImage, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texture.blur);
    gl.uniform1i(u.uBlur, 1);
    const { rect, roll, back } = shotAt(frame.motion, frame.t);
    const bandHeight = 1 - bars * 2;
    gl.uniform1i(u.uMode, frame.motion.mode === "fill" ? 0 : 1);
    gl.uniform4f(u.uRect, rect.x, rect.y, rect.w, rect.h);
    gl.uniform1f(u.uRoll, roll);
    gl.uniform1f(u.uAspect, texture.width / texture.height);
    gl.uniform4f(u.uBack, back.x, back.y, back.w, back.h);
    gl.uniform2f(u.uBand, bars, bandHeight);
    gl.uniform2f(u.uFramePx, this.width, this.height * bandHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (mips) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  private disposeTargets() {
    for (const t of this.targets ?? []) {
      this.gl.deleteFramebuffer(t.fbo);
      this.gl.deleteTexture(t.texture);
    }
    this.targets = null;
  }

  dispose() {
    this.disposeTargets();
    this.gl.deleteProgram(this.compose.program);
    this.gl.deleteProgram(this.final.program);
    this.gl.deleteProgram(this.downsample.program);
    this.gl.deleteProgram(this.gaussian.program);
    this.gl.deleteFramebuffer(this.scratchFbo);
    this.gl.deleteVertexArray(this.vao);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
