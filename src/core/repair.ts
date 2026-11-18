import type { TriMesh } from './mesh';

/**
 * Fix the two defects that stop a mesh becoming a solid:
 * - edges shared by more than two faces (the faces on them are removed), and
 * - holes (each boundary loop is closed with a fan around its center).
 * Returns null when nothing needed fixing.
 */
export function patchMesh(m: TriMesh): { mesh: TriMesh; removed: number; filled: number } | null {
  const nv = m.positions.length / 3;
  const nt = m.indices.length / 3;
  const ekey = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  const count = new Map<number, number>();
  const idx = m.indices;
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const key = ekey(idx[t * 3 + k], idx[t * 3 + ((k + 1) % 3)]);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  let bad = 0, open = 0;
  for (const c of count.values()) { if (c > 2) bad++; else if (c === 1) open++; }
  if (!bad && !open) return null;

  // Drop faces on over-shared edges.
  const keep: number[] = [];
  let removed = 0;
  for (let t = 0; t < nt; t++) {
    let ok = true;
    for (let k = 0; k < 3 && ok; k++) if ((count.get(ekey(idx[t * 3 + k], idx[t * 3 + ((k + 1) % 3)])) ?? 0) > 2) ok = false;
    if (ok) keep.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
    else removed++;
  }

  // Boundary half-edges: directed edges with no opposite twin.
  const half = new Set<number>();
  const dkey = (a: number, b: number) => a * nv + b;
  for (let i = 0; i < keep.length; i += 3) for (let k = 0; k < 3; k++) half.add(dkey(keep[i + k], keep[i + ((k + 1) % 3)]));
  const next = new Map<number, number[]>(); // a -> [b] for boundary edges a->b
  for (let i = 0; i < keep.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = keep[i + k], b = keep[i + ((k + 1) % 3)];
      if (!half.has(dkey(b, a))) {
        const list = next.get(a);
        if (list) list.push(b); else next.set(a, [b]);
      }
    }
  }
  const pos = Array.from(m.positions);
  let filled = 0;
  // Walk loops; fill each with triangles that run opposite to the boundary.
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop = [start];
      let cur = next.get(start)!.pop()!;
      let guard = 0;
      while (cur !== start && guard++ < 1_000_000) {
        loop.push(cur);
        const nb = next.get(cur);
        if (!nb || !nb.length) break;
        cur = nb.pop()!;
      }
      if (cur !== start || loop.length < 3) continue;
      filled++;
      if (loop.length === 3) { keep.push(loop[2], loop[1], loop[0]); continue; }
      let cx = 0, cy = 0, cz = 0;
      for (const v of loop) { cx += pos[v * 3]; cy += pos[v * 3 + 1]; cz += pos[v * 3 + 2]; }
      const c = pos.length / 3;
      pos.push(cx / loop.length, cy / loop.length, cz / loop.length);
      for (let i = 0; i < loop.length; i++) keep.push(loop[(i + 1) % loop.length], loop[i], c);
    }
  }
  return { mesh: { positions: new Float32Array(pos), indices: new Uint32Array(keep) }, removed, filled };
}
