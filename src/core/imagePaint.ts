/**
 * Paint a model from a picture, without AI: project the picture onto the
 * model from the current camera, then reduce the colors to filaments.
 */

export interface RGBImage {
  width: number;
  height: number;
  /** RGBA bytes, row-major from the top-left. */
  data: Uint8ClampedArray;
}

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
}

/** sRGB (0-255) to CIE Lab. */
export function rgbToLab([r, g, b]: RGB): RGB {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * Color difference in Lab with lightness counted at half weight, so the
 * same paint in light and shadow reads as one color, while black vs white
 * (a large lightness gap) still separates.
 */
function labDist(a: RGB, b: RGB): number {
  const dl = (a[0] - b[0]) * 0.5, da = a[1] - b[1], db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

export function colorDist(a: RGB, b: RGB): number {
  return labDist(rgbToLab(a), rgbToLab(b));
}

/** Index of the closest palette color (RGB in, compared in Lab). */
export function nearest(c: RGB, palette: RGB[]): number {
  const l = rgbToLab(c);
  let best = 0, bd = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = labDist(l, rgbToLab(palette[i]));
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function labToRgb([L, A, B]: RGB): RGB {
  const fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const r = X * 3.2406 - Y * 1.5372 - Z * 0.4986, g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415, b = X * 0.0557 - Y * 0.204 + Z * 1.057;
  const gam = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055);
  return [gam(r), gam(g), gam(b)];
}

/**
 * Find up to `k` main colors (k-means in Lab, seeded by farthest-point picks
 * so results repeat), then merge colors closer than `mergeDist` so a
 * two-color model doesn't get split into light and shadow versions.
 * Returned most common first.
 */
export function kmeansColors(samples: RGB[], k: number, iters = 15, mergeDist = 20): RGB[] {
  if (!samples.length) return [];
  const step = Math.max(1, Math.floor(samples.length / 20000));
  const pts = samples.filter((_, i) => i % step === 0).map(rgbToLab);
  k = Math.max(1, Math.min(k, pts.length));
  const avg: RGB = [0, 0, 0];
  for (const p of pts) { avg[0] += p[0]; avg[1] += p[1]; avg[2] += p[2]; }
  const centers: RGB[] = [[avg[0] / pts.length, avg[1] / pts.length, avg[2] / pts.length]];
  const dmin = pts.map((p) => labDist(p, centers[0]));
  while (centers.length < k) {
    let fi = 0;
    for (let i = 1; i < pts.length; i++) if (dmin[i] > dmin[fi]) fi = i;
    if (dmin[fi] === 0) break;
    centers.push([...pts[fi]] as RGB);
    for (let i = 0; i < pts.length; i++) dmin[i] = Math.min(dmin[i], labDist(pts[i], pts[fi]));
  }
  const near = (p: RGB, cs: RGB[]) => { let b = 0, bd = Infinity; for (let i = 0; i < cs.length; i++) { const d = labDist(p, cs[i]); if (d < bd) { bd = d; b = i; } } return b; };
  let counts: number[] = [];
  const run = () => {
    for (let it = 0; it < iters; it++) {
      const sums = centers.map(() => [0, 0, 0]);
      counts = new Array(centers.length).fill(0);
      for (const p of pts) {
        const a = near(p, centers);
        sums[a][0] += p[0]; sums[a][1] += p[1]; sums[a][2] += p[2];
        counts[a]++;
      }
      for (let c = 0; c < centers.length; c++) if (counts[c]) centers[c] = [sums[c][0] / counts[c], sums[c][1] / counts[c], sums[c][2] / counts[c]];
    }
  };
  run();
  // Merge near-duplicates (and drop clusters under 2% of samples), then settle again.
  for (;;) {
    let bi = -1, bj = -1, bd = mergeDist * mergeDist;
    for (let i = 0; i < centers.length; i++) for (let j = i + 1; j < centers.length; j++) {
      // Merging counts lightness even less: lit and shaded grey are one filament.
      const dl = (centers[i][0] - centers[j][0]) * 0.35, da = centers[i][1] - centers[j][1], db = centers[i][2] - centers[j][2];
      const d = dl * dl + da * da + db * db;
      if (d < bd || sameColorInShadow(centers[i], centers[j])) { bd = Math.min(bd, d); bi = i; bj = j; }
    }
    // Keep the more common of the two.
    if (bi >= 0 && counts[bj] > counts[bi]) [bi, bj] = [bj, bi];
    const tiny = counts.findIndex((n) => n < pts.length * 0.02);
    if (bi < 0 && (tiny < 0 || centers.length === 1)) break;
    centers.splice(bi >= 0 ? bj : tiny, 1);
    run();
  }
  return centers.map((c, i) => ({ c, n: counts[i] })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).map((x) => labToRgb(x.c));
}

function medoid(cs: RGB[]): RGB | null {
  if (cs.length <= 2) return cs[0] ?? null;
  const labs = cs.map(rgbToLab);
  let best = 0, bd = Infinity;
  for (let i = 0; i < labs.length; i++) {
    let d = 0;
    for (let j = 0; j < labs.length; j++) d += Math.sqrt(labDist(labs[i], labs[j]));
    if (d < bd) { bd = d; best = i; }
  }
  return cs[best];
}

/** Two saturated colors with the same hue are one paint in light and shadow. */
function sameColorInShadow(a: RGB, b: RGB): boolean {
  const ca = Math.hypot(a[1], a[2]), cb = Math.hypot(b[1], b[2]);
  if (ca < 12 || cb < 12) return false;
  let dh = Math.abs(Math.atan2(a[2], a[1]) - Math.atan2(b[2], b[1]));
  if (dh > Math.PI) dh = 2 * Math.PI - dh;
  return dh < (18 * Math.PI) / 180;
}

/** The picture's background color: the most common color along its border. */
export function borderColor(img: RGBImage): RGB | null {
  const counts = new Map<number, number>();
  const add = (x: number, y: number) => {
    const o = (y * img.width + x) * 4;
    if (img.data[o + 3] < 128) return;
    const key = ((img.data[o] >> 4) << 8) | ((img.data[o + 1] >> 4) << 4) | (img.data[o + 2] >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < img.width; x++) { add(x, 0); add(x, img.height - 1); }
  for (let y = 0; y < img.height; y++) { add(0, y); add(img.width - 1, y); }
  let best = -1, bn = 0;
  for (const [k, n] of counts) if (n > bn) { bn = n; best = k; }
  const total = 2 * (img.width + img.height);
  if (best < 0 || bn < total * 0.6) return null; // no clear background
  return [((best >> 8) & 15) * 16 + 8, ((best >> 4) & 15) * 16 + 8, (best & 15) * 16 + 8];
}

export interface ProjectPart {
  /** Mesh in its own coordinates. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Column-major 4x4 local-to-world matrix. */
  matrixWorld: ArrayLike<number>;
}

export interface ProjectView {
  /** Column-major 4x4 world-to-clip (projection * view). */
  viewProj: ArrayLike<number>;
  cameraPos: [number, number, number];
  /** Canvas size in pixels: the picture is shown "contained" in it. */
  width: number;
  height: number;
}

export interface ProjectOptions {
  /** Also color surfaces facing away, as if the picture showed through (for symmetric models). */
  paintBack: boolean;
  /** Picture scale (1 = fit) and offset in canvas fractions, matching the on-screen overlay. */
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  /** Treat a solid border color as backdrop and skip it (default true). */
  backdrop?: boolean;
}

/** Where the picture sits on the canvas, in canvas pixels (object-fit: contain, then scale/offset). */
export function pictureRect(img: { width: number; height: number }, view: { width: number; height: number }, o: ProjectOptions) {
  const s = Math.min(view.width / img.width, view.height / img.height) * (o.scale ?? 1);
  const w = img.width * s, h = img.height * s;
  return { x: (view.width - w) / 2 + (o.offsetX ?? 0) * view.width, y: (view.height - h) / 2 + (o.offsetY ?? 0) * view.height, w, h };
}

/** Looks up what the picture shows at points on the model, from the current camera. */
export interface Projector {
  /** Whether the picture sees this triangle (facing the camera and not hidden), corners in part coordinates. */
  sees(mw: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>, at?: ArrayLike<number>): boolean;
  /** Picture color at a point in part coordinates, or null where the picture has nothing to say. */
  colorAt(mw: ArrayLike<number>, x: number, y: number, z: number): RGB | null;
  /** Where a point lands in the picture, in picture pixels (null if behind the camera). */
  pixelAt(mw: ArrayLike<number>, x: number, y: number, z: number): [number, number] | null;
}

export function makeProjector(parts: ProjectPart[], view: ProjectView, img: RGBImage, opts: ProjectOptions): Projector {
  const G = 640;
  const depth = new Float32Array(G * G).fill(Infinity);
  const m = view.viewProj;
  const persp = m[3] !== 0 || m[7] !== 0 || m[11] !== 0;
  const toClip = (x: number, y: number, z: number, mw: ArrayLike<number>, out: number[]) => {
    const wx = mw[0] * x + mw[4] * y + mw[8] * z + mw[12];
    const wy = mw[1] * x + mw[5] * y + mw[9] * z + mw[13];
    const wz = mw[2] * x + mw[6] * y + mw[10] * z + mw[14];
    const cx = m[0] * wx + m[4] * wy + m[8] * wz + m[12];
    const cy = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
    const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
    // Depth: distance along the view (clip w) for a perspective camera, clip z for a flat one.
    out[0] = cx / cw; out[1] = cy / cw;
    out[2] = persp ? cw : (m[2] * wx + m[6] * wy + m[10] * wz + m[14]) / cw; out[3] = wx; out[4] = wy; out[5] = wz;
    return cw > 0;
  };
  const pa = [0, 0, 0, 0, 0, 0], pb = [0, 0, 0, 0, 0, 0], pc = [0, 0, 0, 0, 0, 0];
  const gx = (ndc: number) => ((ndc + 1) / 2) * G;
  const gy = (ndc: number) => ((1 - ndc) / 2) * G;
  let zmin = Infinity, zmax = 0;
  for (const part of parts) {
    const P = part.positions, I = part.indices, mw = part.matrixWorld;
    for (let t = 0; t < I.length; t += 3) {
      if (!toClip(P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2], mw, pa)) continue;
      if (!toClip(P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2], mw, pb)) continue;
      if (!toClip(P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2], mw, pc)) continue;
      zmin = Math.min(zmin, pa[2]); zmax = Math.max(zmax, pa[2]);
      const ax = gx(pa[0]), ay = gy(pa[1]), bx = gx(pb[0]), by = gy(pb[1]), cx = gx(pc[0]), cy = gy(pc[1]);
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(G - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(G - 1, Math.ceil(Math.max(ay, by, cy)));
      if (x0 > x1 || y0 > y1) continue;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-9 || (x1 - x0 <= 1 && y1 - y0 <= 1)) {
        const z = Math.min(pa[2], pb[2], pc[2]);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (z < depth[y * G + x]) depth[y * G + x] = z;
        continue;
      }
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
          const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;
          const z = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
          if (z < depth[y * G + x]) depth[y * G + x] = z;
        }
      }
    }
  }
  // Slack for the coarse buffer: 1% of the scene's depth range.
  const slack = Math.max((zmax - zmin) * 0.01, Math.abs(zmin) * 1e-4);
  const rect = pictureRect(img, view, opts);
  const bg = opts.backdrop === false ? null : borderColor(img);
  const bgLab = bg ? rgbToLab(bg) : null;
  const cam = view.cameraPos;
  const q = [0, 0, 0, 0, 0, 0];
  return {
    sees(mw, a, b, c, at) {
      // Test the point at barycentric `at` (default: the centroid).
      const u = at ? at[0] : 1 / 3, v = at ? at[1] : 1 / 3, w = at ? at[2] : 1 / 3;
      const cxl = a[0] * u + b[0] * v + c[0] * w, cyl = a[1] * u + b[1] * v + c[1] * w, czl = a[2] * u + b[2] * v + c[2] * w;
      if (!toClip(cxl, cyl, czl, mw, q)) return false;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const wnx = mw[0] * nx + mw[4] * ny + mw[8] * nz, wny = mw[1] * nx + mw[5] * ny + mw[9] * nz, wnz = mw[2] * nx + mw[6] * ny + mw[10] * nz;
      const facing = wnx * (cam[0] - q[3]) + wny * (cam[1] - q[4]) + wnz * (cam[2] - q[5]) > 0;
      if (!facing) return opts.paintBack;
      const x = Math.floor(gx(q[0])), y = Math.floor(gy(q[1]));
      if (x < 0 || y < 0 || x >= G || y >= G) return false;
      let front = Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < G && yy < G) front = Math.min(front, depth[yy * G + xx]);
      }
      return q[2] - front <= slack;
    },
    pixelAt(mw, x, y, z) {
      if (!toClip(x, y, z, mw, q)) return null;
      const px = ((q[0] + 1) / 2) * view.width, py = ((1 - q[1]) / 2) * view.height;
      return [((px - rect.x) / rect.w) * img.width, ((py - rect.y) / rect.h) * img.height];
    },
    colorAt(mw, x, y, z) {
      const p = this.pixelAt(mw, x, y, z);
      if (!p) return null;
      const ix = Math.floor(p[0]), iy = Math.floor(p[1]);
      if (ix < 0 || iy < 0 || ix >= img.width || iy >= img.height) return null;
      const o = (iy * img.width + ix) * 4;
      if (img.data[o + 3] < 128) return null;
      const c: RGB = [img.data[o], img.data[o + 1], img.data[o + 2]];
      if (bgLab && labDist(rgbToLab(c), bgLab) < 64) return null;
      return c;
    },
  };
}

/**
 * For every triangle of every part, the picture color it sees (or null where
 * the picture doesn't cover it, it is hidden behind other geometry, or faces
 * away). Each triangle takes the most typical of four samples.
 */
export function projectPicture(parts: ProjectPart[], view: ProjectView, img: RGBImage, opts: ProjectOptions): (RGB | null)[][] {
  const proj = makeProjector(parts, view, img, opts);
  return parts.map((part) => {
    const P = part.positions, I = part.indices, mw = part.matrixWorld;
    const out: (RGB | null)[] = new Array(I.length / 3).fill(null);
    for (let t = 0; t < I.length; t += 3) {
      const a = P.subarray(I[t] * 3, I[t] * 3 + 3), b = P.subarray(I[t + 1] * 3, I[t + 1] * 3 + 3), c = P.subarray(I[t + 2] * 3, I[t + 2] * 3 + 3);
      if (!proj.sees(mw, a, b, c)) continue;
      out[t / 3] = sampleTriangle(proj, mw, a, b, c);
    }
    return out;
  });
}

/** The most typical picture color over a triangle (centroid plus three points toward the corners). */
export function sampleTriangle(proj: Projector, mw: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>): RGB | null {
  const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
  const picks: RGB[] = [];
  const c0 = proj.colorAt(mw, cx, cy, cz);
  if (c0) picks.push(c0);
  for (const v of [a, b, c]) {
    const s = proj.colorAt(mw, (cx + 2 * v[0]) / 3, (cy + 2 * v[1]) / 3, (cz + 2 * v[2]) / 3);
    if (s) picks.push(s);
  }
  return medoid(picks);
}
