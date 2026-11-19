import type { TriMesh, Vec3 } from './mesh';
import { triangleNormalsAndAreas } from './mesh';

/** Per-triangle filament slot (0-based) for one part. */
export type PaintLayer = Uint8Array;

export const DEFAULT_PALETTE = ['#E8E4DA', '#D64545', '#2F6FDE', '#F2C230', '#2E9E5B', '#1E1E1E', '#F08A24', '#8E5BD6', '#5BC6D6'];

export class PaintTarget {
  readonly mesh: TriMesh;
  readonly colors: PaintLayer;
  readonly normals: Float32Array;
  readonly centroids: Float32Array;
  private adjacency?: Int32Array; // 3 neighbors per triangle (-1 = none)

  constructor(mesh: TriMesh, colors?: PaintLayer) {
    this.mesh = mesh;
    const n = mesh.indices.length / 3;
    this.colors = colors && colors.length === n ? colors : new Uint8Array(n);
    const info = triangleNormalsAndAreas(mesh);
    this.normals = info.normals;
    this.centroids = info.centroids;
  }

  get triCount() {
    return this.colors.length;
  }

  fillAll(slot: number) {
    this.colors.fill(slot);
  }

  /** Paint triangles whose centers are within `radius` of `point`. Returns how many changed. */
  brush(point: Vec3, radius: number, slot: number): number {
    const r2 = radius * radius;
    const c = this.centroids;
    let changed = 0;
    for (let t = 0; t < this.colors.length; t++) {
      const dx = c[t * 3] - point[0], dy = c[t * 3 + 1] - point[1], dz = c[t * 3 + 2] - point[2];
      if (dx * dx + dy * dy + dz * dz <= r2 && this.colors[t] !== slot) {
        this.colors[t] = slot;
        changed++;
      }
    }
    return changed;
  }

  private buildAdjacency(): Int32Array {
    if (this.adjacency) return this.adjacency;
    const idx = this.mesh.indices;
    const n = idx.length / 3;
    const adj = new Int32Array(n * 3).fill(-1);
    const nv = this.mesh.positions.length / 3;
    const edgeMap = new Map<number, number>();
    for (let t = 0; t < n; t++) {
      for (let e = 0; e < 3; e++) {
        const a = idx[t * 3 + e], b = idx[t * 3 + ((e + 1) % 3)];
        const key = a < b ? a * nv + b : b * nv + a;
        const other = edgeMap.get(key);
        if (other === undefined) edgeMap.set(key, t * 3 + e);
        else {
          const ot = Math.floor(other / 3), oe = other % 3;
          adj[t * 3 + e] = ot;
          adj[ot * 3 + oe] = t;
        }
      }
    }
    this.adjacency = adj;
    return adj;
  }

  /**
   * Flood fill from a triangle across edges flatter than `maxAngle` degrees.
   * Stops at sharp creases, so it fills one "panel" of the model.
   */
  smartFill(startTri: number, slot: number, maxAngle = 30): number {
    const adj = this.buildAdjacency();
    const cosMax = Math.cos((maxAngle * Math.PI) / 180);
    const nrm = this.normals;
    const seen = new Uint8Array(this.colors.length);
    const stack = [startTri];
    seen[startTri] = 1;
    let changed = 0;
    while (stack.length) {
      const t = stack.pop()!;
      if (this.colors[t] !== slot) { this.colors[t] = slot; changed++; }
      for (let e = 0; e < 3; e++) {
        const o = adj[t * 3 + e];
        if (o < 0 || seen[o]) continue;
        const d = nrm[t * 3] * nrm[o * 3] + nrm[t * 3 + 1] * nrm[o * 3 + 1] + nrm[t * 3 + 2] * nrm[o * 3 + 2];
        if (d >= cosMax) { seen[o] = 1; stack.push(o); }
      }
    }
    return changed;
  }

  /** Replace each triangle's slot with the most common slot among it and its neighbors. */
  smooth(passes = 1, mask?: Uint8Array): number {
    const adj = this.buildAdjacency();
    // With a mask, only masked triangles change and only masked neighbors vote.
    const nb = (o: number) => (o < 0 || (mask && !mask[o]) ? -1 : o);
    let changed = 0;
    for (let p = 0; p < passes; p++) {
      const prev = this.colors.slice();
      for (let t = 0; t < prev.length; t++) {
        if (mask && !mask[t]) continue;
        const a = nb(adj[t * 3]), b = nb(adj[t * 3 + 1]), c = nb(adj[t * 3 + 2]);
        const ca = a < 0 ? -1 : prev[a], cb = b < 0 ? -2 : prev[b], cc = c < 0 ? -3 : prev[c];
        // Two or three neighbors agreeing on a different color wins.
        let win = -1;
        if (ca === cb || ca === cc) win = ca; else if (cb === cc) win = cb;
        if (win >= 0 && win !== prev[t]) { this.colors[t] = win; changed++; }
      }
    }
    return changed;
  }

  /** Merge same-colored islands smaller than `minTris` into the color around them. */
  removeSpecks(minTris: number, mask?: Uint8Array): number {
    const adj = this.buildAdjacency();
    const n = this.colors.length;
    const region = new Int32Array(n).fill(-1);
    let changed = 0;
    for (let s = 0; s < n; s++) {
      if (region[s] >= 0 || (mask && !mask[s])) continue;
      const slot = this.colors[s];
      const members = [s];
      region[s] = s;
      const around = new Map<number, number>();
      for (let i = 0; i < members.length; i++) {
        const t = members[i];
        for (let e = 0; e < 3; e++) {
          const o = adj[t * 3 + e];
          if (o < 0 || (mask && !mask[o])) continue;
          if (this.colors[o] === slot) {
            if (region[o] < 0) { region[o] = s; members.push(o); }
          } else around.set(this.colors[o], (around.get(this.colors[o]) ?? 0) + 1);
        }
      }
      if (members.length < minTris && around.size) {
        const to = [...around.entries()].sort((a, b) => b[1] - a[1])[0][0];
        for (const t of members) this.colors[t] = to;
        changed += members.length;
      }
    }
    return changed;
  }

  usedSlots(): number[] {
    const used = new Set<number>();
    for (const c of this.colors) used.add(c);
    return [...used].sort((a, b) => a - b);
  }
}
