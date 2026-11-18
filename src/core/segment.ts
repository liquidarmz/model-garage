/**
 * Split a picture into clean color regions: smooth away texture and noise
 * (keeping edges), group pixels into superpixels, then merge neighbors that
 * are the same paint in light and shadow. The regions give crisp edges and
 * are what the color plan assigns filaments to.
 */
import { type RGB, type RGBImage, rgbToLab, borderColor } from './imagePaint';

export interface Region {
  id: number;
  /** Average picture color (RGB). */
  color: RGB;
  /** Pixels in the segmentation image. */
  area: number;
  /** A point well inside the region (segmentation pixels), for its number label. */
  anchor: [number, number];
}

export interface Segmentation {
  width: number;
  height: number;
  /** Region id per pixel, or -1 for the background. */
  labels: Int32Array;
  regions: Region[];
}

export interface SegmentOptions {
  /** Long side of the working image in pixels. */
  maxSide?: number;
  /** Starting superpixel count. */
  superpixels?: number;
  /** Most regions to return. */
  maxRegions?: number;
  /** Neighbors closer than this (shade-tolerant Lab distance) always merge. */
  mergeDist?: number;
}

/** Box-downscale to at most `maxSide` on the long side. */
export function downscale(img: RGBImage, maxSide: number): RGBImage {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (k === 1) return img;
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const o = (yy * img.width + xx) * 4;
        const al = img.data[o + 3];
        r += img.data[o] * al; g += img.data[o + 1] * al; b += img.data[o + 2] * al; a += al; n++;
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
      out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

/** Lab distance that forgives lighting: lightness counts 40%. */
function shadeDist(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const dl = (a[0] - b[0]) * 0.4, da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

export function segmentPicture(src: RGBImage, o: SegmentOptions = {}): Segmentation {
  const img = downscale(src, o.maxSide ?? 320);
  const W = img.width, H = img.height, N = W * H;
  const maxRegions = o.maxRegions ?? 40;
  const mergeDist = o.mergeDist ?? 12;

  // Lab per pixel, and which pixels are see-through.
  let lab = new Float32Array(N * 3);
  const clear = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const c = rgbToLab([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
    lab[i * 3] = c[0]; lab[i * 3 + 1] = c[1]; lab[i * 3 + 2] = c[2];
    clear[i] = img.data[i * 4 + 3] < 128 ? 1 : 0;
  }

  // Edge-keeping smoothing (bilateral, two passes) so texture and noise fade but outlines stay.
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(N * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let s0 = 0, s1 = 0, s2 = 0, ws = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          const d0 = lab[j * 3] - lab[i * 3], d1 = lab[j * 3 + 1] - lab[i * 3 + 1], d2 = lab[j * 3 + 2] - lab[i * 3 + 2];
          const w = Math.exp(-(d0 * d0 + d1 * d1 + d2 * d2) / (2 * 10 * 10) - (dx * dx + dy * dy) / 8);
          s0 += lab[j * 3] * w; s1 += lab[j * 3 + 1] * w; s2 += lab[j * 3 + 2] * w; ws += w;
        }
      }
      out[i * 3] = s0 / ws; out[i * 3 + 1] = s1 / ws; out[i * 3 + 2] = s2 / ws;
    }
    lab = out;
  }

  // Superpixels (SLIC) in shade-tolerant Lab plus position.
  const K = o.superpixels ?? 700;
  const S = Math.max(2, Math.sqrt(N / K));
  const cs: number[][] = []; // [L, a, b, x, y]
  for (let y = S / 2; y < H; y += S) for (let x = S / 2; x < W; x += S) {
    const i = Math.floor(y) * W + Math.floor(x);
    cs.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], x, y]);
  }
  const label = new Int32Array(N).fill(-1);
  const best = new Float32Array(N);
  const m = 10 / S;
  for (let it = 0; it < 8; it++) {
    best.fill(Infinity);
    for (let k = 0; k < cs.length; k++) {
      const c = cs[k];
      const x0 = Math.max(0, Math.floor(c[3] - 2 * S)), x1 = Math.min(W - 1, Math.ceil(c[3] + 2 * S));
      const y0 = Math.max(0, Math.floor(c[4] - 2 * S)), y1 = Math.min(H - 1, Math.ceil(c[4] + 2 * S));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        const dl = (lab[i * 3] - c[0]) * 0.7, da = lab[i * 3 + 1] - c[1], db = lab[i * 3 + 2] - c[2];
        const dx = (x - c[3]) * m, dy = (y - c[4]) * m;
        const d = dl * dl + da * da + db * db + dx * dx + dy * dy;
        if (d < best[i]) { best[i] = d; label[i] = k; }
      }
    }
    const sum = cs.map(() => [0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < N; i++) {
      const s = sum[label[i]];
      s[0] += lab[i * 3]; s[1] += lab[i * 3 + 1]; s[2] += lab[i * 3 + 2]; s[3] += i % W; s[4] += Math.floor(i / W); s[5]++;
    }
    for (let k = 0; k < cs.length; k++) if (sum[k][5]) cs[k] = sum[k].slice(0, 5).map((v) => v / sum[k][5]);
  }

  // Connected pieces become regions (a superpixel can come out in bits).
  const reg = new Int32Array(N).fill(-1);
  let R = 0;
  const stack: number[] = [];
  for (let s = 0; s < N; s++) {
    if (reg[s] >= 0) continue;
    reg[s] = R; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % W, y = (i - x) / W;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const j of nb) if (j >= 0 && reg[j] < 0 && label[j] === label[i] && clear[j] === clear[i]) { reg[j] = R; stack.push(j); }
    }
    R++;
  }

  // Region stats and adjacency (shared border length).
  const parent = Array.from({ length: R }, (_, i) => i);
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const area = new Float64Array(R), sL = new Float64Array(R), sA = new Float64Array(R), sB = new Float64Array(R), nClear = new Float64Array(R);
  for (let i = 0; i < N; i++) {
    const r = reg[i];
    area[r]++; sL[r] += lab[i * 3]; sA[r] += lab[i * 3 + 1]; sB[r] += lab[i * 3 + 2]; nClear[r] += clear[i];
  }
  const adj: Map<number, number>[] = Array.from({ length: R }, () => new Map());
  const link = (a: number, b: number) => { if (a !== b) { adj[a].set(b, (adj[a].get(b) ?? 0) + 1); adj[b].set(a, (adj[b].get(a) ?? 0) + 1); } };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (x < W - 1) link(reg[i], reg[i + 1]);
    if (y < H - 1) link(reg[i], reg[i + W]);
  }
  const mean = (r: number) => [sL[r] / area[r], sA[r] / area[r], sB[r] / area[r]];
  const isClear = (r: number) => nClear[r] > area[r] / 2;

  // Background: grow from the picture's edges through gently changing color
  // (handles gradient backdrops), and keep groups that cover a good share of
  // the edge. See-through pixels are background too.
  const edgePx = new Float64Array(R);
  for (let x = 0; x < W; x++) { edgePx[reg[x]]++; edgePx[reg[(H - 1) * W + x]]++; }
  for (let y = 0; y < H; y++) { edgePx[reg[y * W]]++; edgePx[reg[y * W + W - 1]]++; }
  const bgColor = borderColor(img);
  const bgLab = bgColor ? rgbToLab(bgColor) : null;
  const grp = new Int32Array(R).fill(-1);
  const grpEdge: number[] = [];
  const fullDist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (let r0 = 0; r0 < R; r0++) {
    if (!edgePx[r0] || grp[r0] >= 0 || isClear(r0)) continue;
    const g = grpEdge.length;
    grpEdge.push(0);
    grp[r0] = g;
    const q = [r0];
    while (q.length) {
      const r = q.pop()!;
      grpEdge[g] += edgePx[r];
      const mr = mean(r);
      for (const n of adj[r].keys()) if (grp[n] < 0 && !isClear(n) && fullDist(mr, mean(n)) < 6) { grp[n] = g; q.push(n); }
    }
  }
  const edgeTotal = 2 * (W + H);
  const bgFlag = new Uint8Array(R);
  for (let r = 0; r < R; r++) {
    if (isClear(r)) bgFlag[r] = 1;
    else if (grp[r] >= 0 && grpEdge[grp[r]] >= edgeTotal * 0.15) bgFlag[r] = 1;
    else if (bgLab && grp[r] >= 0 && edgePx[r] && shadeDist(mean(r), bgLab) < 8) bgFlag[r] = 1;
  }
  const union = (keep: number, gone: number) => {
    parent[gone] = keep;
    area[keep] += area[gone]; sL[keep] += sL[gone]; sA[keep] += sA[gone]; sB[keep] += sB[gone]; nClear[keep] += nClear[gone];
    for (const [n, len] of adj[gone]) {
      if (n === keep) continue;
      adj[keep].set(n, (adj[keep].get(n) ?? 0) + len);
      adj[n].delete(gone);
      adj[n].set(keep, (adj[n].get(keep) ?? 0) + len);
    }
    adj[keep].delete(gone);
    adj[gone].clear();
  };

  // Merge: tiny bits always go to their closest neighbor; then the closest
  // pair merges while it's within mergeDist or there are too many regions.
  const minArea = Math.max(4, N * 0.0015);
  let alive = R;
  const closest = (a: number) => {
    let bb = -1, bd = Infinity;
    const ma = mean(a);
    for (const [b, len] of adj[a]) {
      if (bgFlag[b] !== bgFlag[a] && [...adj[a].keys()].some((n) => bgFlag[n] === bgFlag[a])) continue;
      // Long shared borders merge a little more easily than corner touches.
      const d = shadeDist(ma, mean(b)) / (1 + Math.min(1, len / (4 * S)) * 0.25);
      if (d < bd) { bd = d; bb = b; }
    }
    return { b: bb, d: bd };
  };
  for (;;) {
    let small = -1;
    for (let a = 0; a < R; a++) if (parent[a] === a && area[a] < minArea && adj[a].size && (small < 0 || area[a] < area[small])) small = a;
    let ba = -1, bb = -1, bd = Infinity;
    if (small >= 0) { ba = small; bb = closest(small).b; }
    else {
      for (let a = 0; a < R; a++) {
        if (parent[a] !== a) continue;
        for (const [b] of adj[a]) {
          if (b < a || bgFlag[a] !== bgFlag[b]) continue;
          const len = adj[a].get(b)!;
          const d = shadeDist(mean(a), mean(b)) / (1 + Math.min(1, len / (4 * S)) * 0.25);
          if (d < bd) { bd = d; ba = a; bb = b; }
        }
      }
      if (ba < 0 || (bd > mergeDist && alive <= maxRegions)) break;
    }
    if (bb < 0) break;
    const [keep, gone] = area[ba] >= area[bb] ? [ba, bb] : [bb, ba];
    union(keep, gone);
    alive--;
  }

  const roots = [...new Set(Array.from({ length: R }, (_, r) => find(r)))];
  const isBg = new Map<number, boolean>(roots.map((r) => [r, bgFlag[r] === 1]));

  // Number the regions biggest first, and take the true average color.
  const fg = roots.filter((r) => !isBg.get(r)).sort((a, b) => area[b] - area[a]);
  const id = new Map(fg.map((r, i) => [r, i]));
  const labels = new Int32Array(N);
  const sum = fg.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < N; i++) {
    const k = id.get(find(reg[i])) ?? -1;
    labels[i] = k;
    if (k >= 0) { const s = sum[k]; s[0] += img.data[i * 4]; s[1] += img.data[i * 4 + 1]; s[2] += img.data[i * 4 + 2]; s[3]++; }
  }
  const anchors = regionAnchors(labels, W, H, fg.length);
  const regions: Region[] = fg.map((_, k) => ({
    id: k,
    color: [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]],
    area: sum[k][3],
    anchor: anchors[k],
  }));
  return { width: W, height: H, labels, regions };
}

/** For each region, the pixel farthest from its edge (chamfer distance). */
function regionAnchors(labels: Int32Array, W: number, H: number, n: number): [number, number][] {
  const d = new Float32Array(W * H);
  const BIG = 1e9;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, l = labels[i];
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
      labels[i - 1] !== l || labels[i + 1] !== l || labels[i - W] !== l || labels[i + W] !== l;
    d[i] = edge ? 0 : BIG;
  }
  for (let y = 1; y < H; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    d[i] = Math.min(d[i], d[i - 1] + 1, d[i - W] + 1, d[i - W - 1] + 1.4, d[i - W + 1] + 1.4);
  }
  for (let y = H - 2; y >= 0; y--) for (let x = W - 2; x > 0; x--) {
    const i = y * W + x;
    d[i] = Math.min(d[i], d[i + 1] + 1, d[i + W] + 1, d[i + W + 1] + 1.4, d[i + W - 1] + 1.4);
  }
  const best = new Float32Array(n).fill(-1);
  const out: [number, number][] = Array.from({ length: n }, () => [0, 0]);
  for (let i = 0; i < W * H; i++) {
    const l = labels[i];
    if (l >= 0 && d[i] > best[l]) { best[l] = d[i]; out[l] = [i % W, Math.floor(i / W)]; }
  }
  return out;
}

export interface PlanColor {
  name: string;
  hex: string;
}

/** Which plan color each region gets (-1: leave unpainted). */
export interface PaintPlan {
  colors: PlanColor[];
  assign: number[];
  notes?: string;
  source: 'claude' | 'local';
}

/** Flat-colored picture of a plan: each region in its plan color, the rest see-through. */
export function planImage(seg: Segmentation, plan: PaintPlan, rgb: (hex: string) => RGB): RGBImage {
  const cols = plan.colors.map((c) => rgb(c.hex));
  const data = new Uint8ClampedArray(seg.width * seg.height * 4);
  for (let i = 0; i < seg.labels.length; i++) {
    const r = seg.labels[i];
    const k = r >= 0 ? plan.assign[r] ?? -1 : -1;
    if (k < 0 || !cols[k]) continue;
    data[i * 4] = cols[k][0]; data[i * 4 + 1] = cols[k][1]; data[i * 4 + 2] = cols[k][2]; data[i * 4 + 3] = 255;
  }
  return { width: seg.width, height: seg.height, data };
}
