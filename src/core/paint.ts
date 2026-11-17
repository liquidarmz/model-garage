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

  usedSlots(): number[] {
    const used = new Set<number>();
    for (const c of this.colors) used.add(c);
    return [...used].sort((a, b) => a - b);
  }
}
