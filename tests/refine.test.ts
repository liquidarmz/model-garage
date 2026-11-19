import { describe, it, expect } from 'vitest';
import { makeProjector, nearest, type RGBImage, type RGB } from '../src/core/imagePaint';
import { refineAndPaint } from '../src/core/refine';
import { analyzeMesh, type TriMesh } from '../src/core/mesh';

// A closed box (so the mesh-health check is meaningful), front face toward +Z.
function box(): TriMesh {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
  return { positions: new Float32Array(p), indices: new Uint32Array(f) };
}
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const view = { viewProj: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, -0.01, 0, 0, 0, 0.5, 1], cameraPos: [0, 0, 100] as [number, number, number], width: 200, height: 200 };

// 200 px picture: red left of x = 0.13 (picture column 126), blue right of it.
function picture(): RGBImage {
  const w = 200, h = 200, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(x < 126 ? [220, 30, 30, 255] : [30, 60, 220, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

describe('refineAndPaint', () => {
  it('splits triangles along a color edge and keeps the mesh closed', () => {
    const m = box();
    const proj = makeProjector([{ positions: m.positions, indices: m.indices, matrixWorld: I }], view, picture(), { paintBack: false, backdrop: false });
    const pal: RGB[] = [[220, 30, 30], [30, 60, 220]];
    const r = refineAndPaint(m, new Uint8Array(12), I, proj, (c) => nearest(c, pal), { minEdge: 0.005, maxTris: 50000 });
    expect(r.added).toBeGreaterThan(50);
    const h = analyzeMesh(r.mesh);
    expect(h.openEdges).toBe(0);
    expect(h.nonManifoldEdges).toBe(0);
    expect(h.volume).toBeCloseTo(1, 5);
    // Painted front triangles away from the edge have the right color.
    const P = r.mesh.positions, X = r.mesh.indices;
    let wrong = 0, checked = 0;
    for (let t = 0; t < X.length / 3; t++) {
      if (!r.painted[t]) continue;
      const cx = (P[X[t * 3] * 3] + P[X[t * 3 + 1] * 3] + P[X[t * 3 + 2] * 3]) / 3;
      if (Math.abs(cx - 0.13) < 0.02) continue;
      checked++;
      if (r.colors[t] !== (cx < 0.13 ? 0 : 1)) wrong++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(wrong).toBe(0);
  });
});
