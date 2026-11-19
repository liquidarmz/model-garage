import { describe, it, expect, beforeAll } from 'vitest';
import { getKernel, fromSolid, toSolid, splitSolid, solidBounds, sectionAt } from '../src/core/geometry';
import { sampleFigure } from '../src/core/samples';
import { suggestPlans } from '../src/core/smartcut';
import { buildParts } from '../src/core/pipeline';
import { DEFAULT_CONNECTOR, type ConnectorType } from '../src/core/connectors';
import { PRINTERS, fitsPrinterAnyOrientation } from '../src/core/printers';
import { analyzeMesh } from '../src/core/mesh';
import { parseSTL, parse3MF, parseOBJ } from '../src/core/loaders';
import { export3mf, paintCode } from '../src/core/export3mf';
import { layoutOnPlates, rotationBetween, faceDown } from '../src/core/orient';
import { PaintTarget } from '../src/core/paint';

const P2S = PRINTERS[0];

function toBinarySTL(m: { positions: Float32Array; indices: Uint32Array }): ArrayBuffer {
  const n = m.indices.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const v = new DataView(buf);
  v.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12;
    for (let k = 0; k < 3; k++) {
      const i = m.indices[t * 3 + k];
      for (let c = 0; c < 3; c++) { v.setFloat32(o, m.positions[i * 3 + c], true); o += 4; }
    }
    o += 2;
  }
  return buf;
}

describe('geometry kernel', () => {
  it('transforms use column-major matrices', async () => {
    const { Manifold } = await getKernel();
    const cube = Manifold.cube([10, 10, 10]);
    const moved = cube.transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] as never);
    expect(solidBounds(moved).min[0]).toBeCloseTo(5);
    const rot = cube.transform(rotationBetween([0, 0, 1], [1, 0, 0]) as never);
    const b = solidBounds(rot);
    expect(b.max[0] - b.min[0]).toBeCloseTo(10);
    expect(b.min[0]).toBeGreaterThan(-0.01); // +z went to +x
  });

  it('section of a cube on a tilted plane has the expected area', async () => {
    const { Manifold } = await getKernel();
    const cube = Manifold.cube([20, 20, 20], true);
    expect(sectionAt(cube, { normal: [1, 0, 0], offset: 0 }).area()).toBeCloseTo(400, 0);
  });

  it('faceDown puts the chosen face on the plate', async () => {
    const { Manifold } = await getKernel();
    const cube = Manifold.cube([10, 20, 30]);
    const placed = faceDown(cube, [1, 0, 0]);
    const b = solidBounds(placed);
    expect(b.min[2]).toBeCloseTo(0);
    expect(b.max[2]).toBeCloseTo(10);
  });
});

describe('loaders', () => {
  it('round-trips binary STL into a watertight solid', async () => {
    const fig = await sampleFigure(120);
    const stl = toBinarySTL(fromSolid(fig));
    const mesh = parseSTL(stl);
    expect(analyzeMesh(mesh).watertight).toBe(true);
    const { solid } = await toSolid(mesh);
    expect(solid.volume()).toBeCloseTo(fig.volume(), -1);
  });

  it('reads OBJ quads', () => {
    const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n';
    expect(parseOBJ(obj).indices.length).toBe(6);
  });
});

describe('smart cut', () => {
  let fig: Awaited<ReturnType<typeof sampleFigure>>;
  let plans: Awaited<ReturnType<typeof suggestPlans>>;
  beforeAll(async () => {
    fig = await sampleFigure(300);
    plans = await suggestPlans(fig, P2S);
  }, 60000);

  it('suggests plans that make a 300 mm figure fit a P2S', async () => {
    expect(fitsPrinterAnyOrientation([140, 80, 300], P2S)).toBe(false);
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      expect(p.cuts.length).toBeGreaterThan(0);
      expect(p.allFit).toBe(true);
    }
    const hidden = plans.find((p) => p.preset.kind === 'hidden')!;
    // The head/neck seam should be among the hidden-seam cuts.
    expect(hidden.cuts.some((c) => c.neck > 0.3)).toBe(true);
  }, 60000);

  it.each(['dowel', 'pin', 'socket', 'dovetail', 'snap', 'magnet'] as ConnectorType[])(
    'builds watertight parts with %s connectors', async (type) => {
      const plan = plans[0];
      const res = await buildParts(fig, plan.cuts, { ...DEFAULT_CONNECTOR, type });
      expect(res.parts.length).toBeGreaterThanOrEqual(plan.partCount);
      expect(res.connectorsPlaced).toBeGreaterThan(0);
      for (const p of res.parts) {
        expect(p.solid.status()).toBe('NoError');
        expect(p.solid.volume()).toBeGreaterThan(0);
        expect(analyzeMesh(fromSolid(p.solid)).watertight).toBe(true);
      }
      if (type === 'dowel') expect(res.parts.some((p) => p.kind === 'pin')).toBe(true);
      // Connectors must not change total volume much (pegs fill holes).
      const vol = res.parts.filter((p) => p.kind === 'part').reduce((s, p) => s + p.solid.volume(), 0);
      expect(Math.abs(vol - fig.volume()) / fig.volume()).toBeLessThan(0.05);
    }, 60000);

  it('split halves add up', async () => {
    const fig = await sampleFigure(200);
    const [a, b] = splitSolid(fig, { normal: [0, 0, 1], offset: 100 });
    expect(a.volume() + b.volume()).toBeCloseTo(fig.volume(), -1);
  });
});

describe('export', () => {
  it('paint codes match the slicer format', () => {
    expect(paintCode(0)).toBe('4');
    expect(paintCode(1)).toBe('8');
    expect(paintCode(2)).toBe('0C');
    expect(paintCode(3)).toBe('1C');
  });

  it('writes a 3MF that reads back with all parts on the plate', async () => {
    const fig = await sampleFigure(300);
    const plans = await suggestPlans(fig, P2S);
    const res = await buildParts(fig, plans[0].cuts, DEFAULT_CONNECTOR);
    const placed = layoutOnPlates(res.parts, P2S);
    const objects = placed.map((pp, i) => {
      const mesh = fromSolid(pp.solid);
      const paint = new PaintTarget(mesh);
      if (i === 0) paint.brush([0, 0, 0], 1e6, 1);
      return { name: `Part ${i + 1}`, mesh, colors: paint.colors };
    });
    for (const pp of placed) expect(solidBounds(pp.solid).min[2]).toBeCloseTo(0, 3);
    const bytes = await export3mf(objects, ['#ffffff', '#ff0000']);
    const back = await parse3MF(bytes.buffer as ArrayBuffer);
    expect(back.indices.length).toBe(objects.reduce((s, o) => s + o.mesh.indices.length, 0));
  }, 60000);
});
