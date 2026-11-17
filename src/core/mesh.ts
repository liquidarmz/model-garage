/** Plain indexed triangle mesh used everywhere outside the geometry kernel. */
export interface TriMesh {
  positions: Float32Array; // xyz per vertex
  indices: Uint32Array; // 3 per triangle
}

export type Vec3 = [number, number, number];

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function triCount(m: TriMesh): number {
  return m.indices.length / 3;
}

export function computeBounds(positions: ArrayLike<number>): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

export function boundsSize(b: Bounds): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function boundsCenter(b: Bounds): Vec3 {
  return [(b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2];
}

/**
 * Merge vertices that sit within `tolerance` of each other and drop triangles
 * that collapse. Takes either an unindexed triangle soup (indices omitted) or
 * an indexed mesh.
 */
export function weld(positions: ArrayLike<number>, indices?: ArrayLike<number>, tolerance = 1e-4): TriMesh {
  // Integer-hash tables (open addressing) instead of string keys: ~10x faster on million-triangle meshes.
  const inv = 1 / tolerance;
  const nVerts = positions.length / 3;
  let size = 1;
  while (size < nVerts * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const q = new Int32Array(nVerts * 3);
  const out = new Float32Array(nVerts * 3);
  const remap = new Uint32Array(nVerts);
  let nOut = 0;
  for (let i = 0; i < nVerts; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const qx = Math.round(x * inv), qy = Math.round(y * inv), qz = Math.round(z * inv);
    let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & mask;
    let found = -1;
    while (table[h] !== -1) {
      const k = table[h];
      if (q[k * 3] === qx && q[k * 3 + 1] === qy && q[k * 3 + 2] === qz) { found = k; break; }
      h = (h + 1) & mask;
    }
    if (found < 0) {
      found = nOut++;
      table[h] = found;
      q[found * 3] = qx; q[found * 3 + 1] = qy; q[found * 3 + 2] = qz;
      out[found * 3] = x; out[found * 3 + 1] = y; out[found * 3 + 2] = z;
    }
    remap[i] = found;
  }
  const nSrc = indices ? indices.length : nVerts;
  const at = (t: number) => (indices ? indices[t] : t);
  const nTri = Math.floor(nSrc / 3);
  let fsize = 1;
  while (fsize < nTri * 2) fsize <<= 1;
  const fmask = fsize - 1;
  const ftable = new Int32Array(fsize).fill(-1);
  const keys = new Uint32Array(nTri * 4); // sorted a, b, c and winding parity
  const tris = new Uint32Array(nTri * 3);
  let nKept = 0;
  for (let t = 0; t < nTri; t++) {
    const a = remap[at(t * 3)], b = remap[at(t * 3 + 1)], c = remap[at(t * 3 + 2)];
    if (a === b || b === c || a === c) continue;
    // Drop exact duplicate faces (same winding), common in bad exports.
    let lo = a, mid = b, hi = c;
    if (lo > mid) [lo, mid] = [mid, lo];
    if (mid > hi) [mid, hi] = [hi, mid];
    if (lo > mid) [lo, mid] = [mid, lo];
    const par = ((a > b ? 1 : 0) + (a > c ? 1 : 0) + (b > c ? 1 : 0)) & 1; // winding: permutation parity
    let h = (Math.imul(lo, 73856093) ^ Math.imul(mid, 19349663) ^ Math.imul(hi, 83492791) ^ par) & fmask;
    let dup = false;
    while (ftable[h] !== -1) {
      const k = ftable[h] * 4;
      if (keys[k] === lo && keys[k + 1] === mid && keys[k + 2] === hi && keys[k + 3] === par) { dup = true; break; }
      h = (h + 1) & fmask;
    }
    if (dup) continue;
    ftable[h] = nKept;
    keys[nKept * 4] = lo; keys[nKept * 4 + 1] = mid; keys[nKept * 4 + 2] = hi; keys[nKept * 4 + 3] = par;
    tris[nKept * 3] = a; tris[nKept * 3 + 1] = b; tris[nKept * 3 + 2] = c;
    nKept++;
  }
  return { positions: out.slice(0, nOut * 3), indices: tris.slice(0, nKept * 3) };
}

export interface MeshHealth {
  triangles: number;
  vertices: number;
  size: Vec3;
  openEdges: number;
  nonManifoldEdges: number;
  volume: number; // mm^3, signed (negative = inside out)
  watertight: boolean;
}

export function analyzeMesh(m: TriMesh): MeshHealth {
  const edges = new Map<number, number>();
  const nv = m.positions.length / 3;
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  let vol = 0;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t], b = m.indices[t + 1], c = m.indices[t + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = key(u, v);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
    const cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let open = 0, nonMan = 0;
  for (const n of edges.values()) {
    if (n === 1) open++;
    else if (n > 2) nonMan++;
  }
  return {
    triangles: m.indices.length / 3,
    vertices: nv,
    size: boundsSize(computeBounds(m.positions)),
    openEdges: open,
    nonManifoldEdges: nonMan,
    volume: vol,
    watertight: open === 0 && nonMan === 0,
  };
}

/** Flip every triangle (used when a mesh comes in inside out). */
export function flipWinding(m: TriMesh): TriMesh {
  const idx = new Uint32Array(m.indices.length);
  for (let t = 0; t < idx.length; t += 3) {
    idx[t] = m.indices[t];
    idx[t + 1] = m.indices[t + 2];
    idx[t + 2] = m.indices[t + 1];
  }
  return { positions: m.positions, indices: idx };
}

/** Area-weighted per-triangle normals and areas. */
export function triangleNormalsAndAreas(m: TriMesh): { normals: Float32Array; areas: Float32Array; centroids: Float32Array } {
  const n = m.indices.length / 3;
  const normals = new Float32Array(n * 3);
  const areas = new Float32Array(n);
  const centroids = new Float32Array(n * 3);
  const p = m.positions;
  for (let t = 0; t < n; t++) {
    const a = m.indices[t * 3] * 3, b = m.indices[t * 3 + 1] * 3, c = m.indices[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    areas[t] = len / 2;
    if (len > 0) {
      normals[t * 3] = nx / len;
      normals[t * 3 + 1] = ny / len;
      normals[t * 3 + 2] = nz / len;
    }
    centroids[t * 3] = (p[a] + p[b] + p[c]) / 3;
    centroids[t * 3 + 1] = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
    centroids[t * 3 + 2] = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
  }
  return { normals, areas, centroids };
}

/** Apply a column-major 4x4 matrix to a mesh (returns a new mesh). */
export function transformMesh(m: TriMesh, mat: ArrayLike<number>): TriMesh {
  const p = m.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = mat[0] * x + mat[4] * y + mat[8] * z + mat[12];
    out[i + 1] = mat[1] * x + mat[5] * y + mat[9] * z + mat[13];
    out[i + 2] = mat[2] * x + mat[6] * y + mat[10] * z + mat[14];
  }
  // A mirroring matrix flips winding; keep outward normals.
  const det =
    mat[0] * (mat[5] * mat[10] - mat[9] * mat[6]) -
    mat[4] * (mat[1] * mat[10] - mat[9] * mat[2]) +
    mat[8] * (mat[1] * mat[6] - mat[5] * mat[2]);
  const res = { positions: out, indices: m.indices };
  return det < 0 ? flipWinding(res) : res;
}

export function translateMesh(m: TriMesh, d: Vec3): TriMesh {
  return transformMesh(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d[0], d[1], d[2], 1]);
}
