import { describe, it, expect } from 'vitest';
import { GeometryEngine } from '../src/core/engine';
import { getKernel } from '../src/core/geometry';
import { PRINTERS } from '../src/core/printers';
import { DEFAULT_CONNECTOR } from '../src/core/connectors';

describe('geometry engine', () => {
  it('runs the whole flow on plain data and frees solids as it goes', async () => {
    const eng = new GeometryEngine();
    const base = await eng.sample(300);
    expect(base.part.mesh.indices.length).toBeGreaterThan(0);
    const plans = await eng.suggest(PRINTERS[0]);
    const plan = plans.find((p) => p.cuts.length > 0)!;
    const wasm = (await getKernel()) as unknown as { HEAP8?: Int8Array };
    const heap = () => wasm.HEAP8?.length ?? 0;
    let first = 0;
    for (let i = 0; i < 6; i++) {
      const res = await eng.build(plan.cuts, { ...DEFAULT_CONNECTOR, type: 'dowel' });
      expect(res.parts.length).toBeGreaterThan(plan.cuts.length);
      const placed = await eng.layout(PRINTERS[0]);
      expect(placed.length).toBe(res.parts.length);
      if (i === 1) first = heap();
    }
    // WASM memory should stop growing once the working set is allocated.
    if (first) expect(heap()).toBeLessThanOrEqual(first * 1.25);
    const anchor = await eng.anchor({ normal: [0, 0, 1], offset: 100 });
    expect(anchor).not.toBeNull();
    eng.dispose();
  }, 120000);
});
