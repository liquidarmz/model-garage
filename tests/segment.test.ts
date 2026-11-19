import { describe, it, expect } from 'vitest';
import { segmentPicture, planImage } from '../src/core/segment';
import { hexToRgb, type RGBImage } from '../src/core/imagePaint';

/** White backdrop, a red block shaded top to bottom, and a blue block beside it. */
function scene(): RGBImage {
  const W = 200, H = 160, data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    let c = [250, 250, 250];
    const shade = 1 - (y - 30) / 250;
    if (x >= 30 && x < 100 && y >= 30 && y < 130) c = [200 * shade, 30 * shade, 40 * shade];
    else if (x >= 100 && x < 170 && y >= 30 && y < 130) c = [30, 60, 200];
    const n = ((x * 7 + y * 13) % 9) - 4; // texture noise
    data[o] = c[0] + n; data[o + 1] = c[1] + n; data[o + 2] = c[2] + n; data[o + 3] = 255;
  }
  return { width: W, height: H, data };
}

describe('segmentPicture', () => {
  it('finds the two painted blocks and drops the backdrop', () => {
    const seg = segmentPicture(scene(), { maxSide: 200 });
    expect(seg.regions.length).toBe(2);
    const reds = seg.regions.filter((r) => r.color[0] > r.color[2]);
    expect(reds.length).toBe(1);
    // A corner pixel is background, a block center is not.
    expect(seg.labels[0]).toBe(-1);
    expect(seg.labels[80 * seg.width + 60]).toBeGreaterThanOrEqual(0);
    for (const r of seg.regions) expect(seg.labels[r.anchor[1] * seg.width + r.anchor[0]]).toBe(r.id);
  });

  it('draws a plan as flat colors', () => {
    const seg = segmentPicture(scene(), { maxSide: 200 });
    const img = planImage(seg, { colors: [{ name: 'A', hex: '#ff0000' }, { name: 'B', hex: '#0000ff' }], assign: [0, 1], source: 'local' }, hexToRgb);
    expect(img.data[3]).toBe(0);
    const o = (80 * seg.width + 60) * 4;
    expect(img.data[o + 3]).toBe(255);
  });
});
