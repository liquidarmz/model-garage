/**
 * Paint can only change color from one triangle to the next, so a picture
 * painted onto big triangles looks blocky. This splits triangles wherever
 * the picture changes color inside them, down to about one picture pixel (or
 * a fraction of a nozzle width), and keeps the mesh closed: every split edge
 * is split on both sides, so the slicer still sees a solid.
 */
import type { TriMesh } from './mesh';
import type { Projector, RGB } from './imagePaint';

const FINAL = [[1 / 3, 1 / 3, 1 / 3], [5 / 9, 2 / 9, 2 / 9], [2 / 9, 5 / 9, 2 / 9], [2 / 9, 2 / 9, 5 / 9]];

export interface RefineOptions {
  /** Don't split edges shorter than this (mm). */
  minEdge: number;
  /** Stop once the part has this many triangles. */
  maxTris: number;
  /** Most rounds of splitting (each halves edge lengths). */
  maxPasses?: number;
  /** Stop splitting when a triangle covers fewer picture pixels across than this. */
  minPixels?: number;
}

export interface RefineResult {
  mesh: TriMesh;
  colors: Uint8Array;
  /** 1 for triangles the picture painted. */
  painted: Uint8Array;
  added: number;
}

export function refineAndPaint(
  mesh: TriMesh, colors: Uint8Array, mw: ArrayLike<number>, proj: Projector,
  slotOf: (c: RGB) => number, o: RefineOptions,
): RefineResult {
  // Same color in, same slot out: remember answers (color matching is the slow part).
  const memo = new Map<number, number>();
  const rawSlot = slotOf;
  slotOf = (c: RGB) => {
    const k = (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]);
    let v = memo.get(k);
    if (v === undefined) { v = rawSlot(c); memo.set(k, v); }
    return v;
  };
  const pos: number[] = Array.from(mesh.positions);
  let idx: number[] = Array.from(mesh.indices);
  let col: number[] = Array.from(colors);
  const startTris = idx.length / 3;
  const minPx = o.minPixels ?? 1.2;
  const min2 = o.minEdge * o.minEdge;
  let cand = new Uint8Array(startTris).fill(1);
  const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
  const load = (t: number) => {
    for (let k = 0; k < 3; k++) { A[k] = pos[idx[t * 3] * 3 + k]; B[k] = pos[idx[t * 3 + 1] * 3 + k]; C[k] = pos[idx[t * 3 + 2] * 3 + k]; }
  };
  const d2 = (p: number[], q: number[]) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const at = (u: number, v: number, w: number): RGB | null =>
    proj.colorAt(mw, A[0] * u + B[0] * v + C[0] * w, A[1] * u + B[1] * v + C[1] * w, A[2] * u + B[2] * v + C[2] * w);
  // Barycentric sample points: centroid, inset corners, inset edge middles.
  const probes = [[1 / 3, 1 / 3, 1 / 3], [0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8], [0.45, 0.45, 0.1], [0.1, 0.45, 0.45], [0.45, 0.1, 0.45]];

  for (let pass = 0; pass < (o.maxPasses ?? 10); pass++) {
    const nTri = idx.length / 3;
    const mark = new Map<number, number>(); // edge key -> new vertex (or -1 until made)
    const key = (a: number, b: number) => (a < b ? a * 4194304 + b : b * 4194304 + a);
    let budget = o.maxTris - nTri;
    for (let t = 0; t < nTri && budget > 0; t++) {
      if (!cand[t]) continue;
      load(t);
      const longest = Math.max(d2(A, B), d2(B, C), d2(C, A));
      if (longest < min2) continue;
      // Size in picture pixels: no point splitting below the picture's detail.
      const pa = proj.pixelAt(mw, A[0], A[1], A[2]), pb = proj.pixelAt(mw, B[0], B[1], B[2]), pc = proj.pixelAt(mw, C[0], C[1], C[2]);
      if (!pa || !pb || !pc) continue;
      const span = Math.max(Math.hypot(pa[0] - pb[0], pa[1] - pb[1]), Math.hypot(pb[0] - pc[0], pb[1] - pc[1]), Math.hypot(pc[0] - pa[0], pc[1] - pa[1]));
      if (span < minPx) continue;
      // What each probe will end up as: the picture's color where it's seen,
      // otherwise the triangle keeps its current color. Split only where those differ,
      // so paint follows color edges and the edges of whatever is in front.
      let seen = false, first = -1, mixed = false;
      for (const pr of probes) {
        let s = col[t];
        if (proj.sees(mw, A, B, C, pr)) {
          seen = true;
          const c = at(pr[0], pr[1], pr[2]);
          if (c) s = slotOf(c);
        }
        if (first < 0) first = s; else if (s !== first) mixed = true;
      }
      if (!seen) continue;
      if (!mixed) continue;
      const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
      for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]]) {
        const k = key(a, b);
        if (!mark.has(k)) { mark.set(k, -1); budget -= 2; }
      }
    }
    if (!mark.size) break;
    const mid = (a: number, b: number) => {
      const k = key(a, b);
      let m = mark.get(k)!;
      if (m < 0) {
        m = pos.length / 3;
        pos.push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2);
        mark.set(k, m);
      }
      return m;
    };
    const nIdx: number[] = [], nCol: number[] = [], nCand: number[] = [];
    const add = (a: number, b: number, c: number, color: number, isCand: number) => { nIdx.push(a, b, c); nCol.push(color); nCand.push(isCand); };
    for (let t = 0; t < nTri; t++) {
      const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
      const cut = [0, 1, 2].map((e) => mark.has(key(v[e], v[(e + 1) % 3])));
      const n = cut.filter(Boolean).length;
      const color = col[t];
      if (n === 0) { add(v[0], v[1], v[2], color, 0); continue; }
      if (n === 3) {
        const m01 = mid(v[0], v[1]), m12 = mid(v[1], v[2]), m20 = mid(v[2], v[0]);
        add(v[0], m01, m20, color, 1); add(m01, v[1], m12, color, 1); add(m20, m12, v[2], color, 1); add(m01, m12, m20, color, 1);
        continue;
      }
      // Rotate so the (first) cut edge is v0-v1.
      let r = cut.indexOf(true);
      if (n === 2 && cut[0] && cut[2]) r = 2; // cut edges 2-0 and 0-1: start at edge 2
      const a = v[r], b = v[(r + 1) % 3], c = v[(r + 2) % 3];
      const mab = mid(a, b);
      if (n === 1) { add(a, mab, c, color, 1); add(mab, b, c, color, 1); continue; }
      // Edges a-b and b-c are cut.
      const mbc = mid(b, c);
      add(mab, b, mbc, color, 1); add(a, mab, mbc, color, 1); add(a, mbc, c, color, 1);
    }
    idx = nIdx; col = nCol; cand = Uint8Array.from(nCand);
  }

  // Final colors from the picture.
  const nTri = idx.length / 3;
  const out = Uint8Array.from(col);
  const painted = new Uint8Array(nTri);
  for (let t = 0; t < nTri; t++) {
    load(t);
    if (!proj.sees(mw, A, B, C)) continue;
    // Majority of four samples (centroid first, so it wins ties).
    let best = -1, bestN = 0;
    const votes: number[] = [];
    for (const [u, v, w] of FINAL) {
      const c = at(u, v, w);
      if (!c) continue;
      const k = slotOf(c);
      votes.push(k);
      const n = votes.filter((x) => x === k).length;
      if (n > bestN) { bestN = n; best = k; }
    }
    if (best >= 0) { out[t] = best; painted[t] = 1; }
  }
  return {
    mesh: { positions: new Float32Array(pos), indices: new Uint32Array(idx) },
    colors: out,
    painted,
    added: nTri - startTris,
  };
}
