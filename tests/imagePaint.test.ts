import { describe, it, expect } from 'vitest';
import { kmeansColors, projectPicture, nearest, type RGBImage } from '../src/core/imagePaint';
import { PaintTarget } from '../src/core/paint';
import type { TriMesh } from '../src/core/mesh';

// Unit quad grid in the XY plane facing +Z, n x n cells.
function grid(n: number, z = 0): TriMesh {
  const pos: number[] = [], idx: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) pos.push(x / n - 0.5, y / n - 0.5, z);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// Orthographic-ish: clip = world (x, y) scaled into [-1, 1], camera far up +Z.
const view = { viewProj: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, -0.01, 0, 0, 0, 0.5, 1], cameraPos: [0, 0, 100] as [number, number, number], width: 100, height: 100 };

function halves(): RGBImage {
  const w = 10, h = 10, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    data.set(x < 5 ? [220, 30, 30, 255] : [30, 60, 220, 255], o);
  }
  return { width: w, height: h, data };
}

describe('paint from picture', () => {
  it('finds the main colors', () => {
    const s = [...Array(300)].map((_, i) => (i % 3 ? [250, 10, 10] : [10, 10, 250]) as [number, number, number]);
    const c = kmeansColors(s, 2);
    expect(c.length).toBe(2);
    expect(c[0][0]).toBeGreaterThan(200); // red is most common
    expect(nearest([0, 0, 200], c)).toBe(1);
  });

  it('projects left/right halves onto a facing surface and skips hidden ones', () => {
    const front = grid(8, 0.2), behind = grid(8, -0.2);
    const res = projectPicture([
      { positions: front.positions, indices: front.indices, matrixWorld: I },
      { positions: behind.positions, indices: behind.indices, matrixWorld: I },
    ], view, halves(), { paintBack: false });
    const f = res[0];
    expect(f.every((c) => c !== null)).toBe(true);
    // Triangle centroids left of center are red, right are blue.
    const cx = (t: number) => (front.positions[front.indices[t * 3] * 3] + front.positions[front.indices[t * 3 + 1] * 3] + front.positions[front.indices[t * 3 + 2] * 3]) / 3;
    for (let t = 0; t < f.length; t++) {
      if (Math.abs(cx(t)) < 0.1) continue;
      expect(cx(t) < 0 ? f[t]![0] > 200 : f[t]![2] > 200).toBe(true);
    }
    // The surface behind is hidden by the front one.
    expect(res[1].filter((c) => c !== null).length).toBe(0);
  });

  it('cleans up specks', () => {
    const g = grid(10);
    const p = new PaintTarget(g);
    p.colors[57] = 3; // one stray triangle
    expect(p.removeSpecks(4)).toBe(1);
    expect(p.usedSlots()).toEqual([0]);
  });
});
