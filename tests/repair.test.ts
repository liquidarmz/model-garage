import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { patchMesh } from '../src/core/repair';
import { toSolid } from '../src/core/geometry';
import { parse3MFItems } from '../src/core/loaders';
import type { TriMesh } from '../src/core/mesh';

function cube(x = 0, size = 10): TriMesh {
  const s = size;
  const p = [0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, 0, 0, s, s, 0, s, s, s, s, 0, s, s].map((v, i) => (i % 3 === 0 ? v + x : v));
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float32Array(p), indices: new Uint32Array(f) };
}

describe('repair', () => {
  it('closes a missing face', async () => {
    const c = cube();
    const open: TriMesh = { positions: c.positions, indices: c.indices.slice(6) }; // drop the bottom
    const fixed = patchMesh(open)!;
    expect(fixed.filled).toBe(1);
    const { solid } = await toSolid(fixed.mesh);
    expect(solid.volume()).toBeCloseTo(1000, 0);
    solid.delete();
  });

  it('repairs an open mesh end to end', async () => {
    const c = cube();
    const { solid, repaired } = await toSolid({ positions: c.positions, indices: c.indices.slice(6) });
    expect(solid.volume()).toBeCloseTo(1000, 0);
    expect(repaired.join(' ')).toMatch(/Filled holes/);
    solid.delete();
  });

  it('keeps touching objects apart until it unions them', async () => {
    // Two cubes sharing a face: welded as one mesh they make bad edges.
    const { solid, repaired } = await toSolid([cube(0), cube(10)]);
    expect(solid.volume()).toBeCloseTo(2000, 0);
    expect(repaired.join(' ')).toMatch(/Joined 2 objects/);
    solid.delete();
  });

  it('reads 3MF build items with names and negative parts', async () => {
    const meshXml = (m: TriMesh) => '<mesh><vertices>' +
      Array.from({ length: m.positions.length / 3 }, (_, i) => `<vertex x="${m.positions[i * 3]}" y="${m.positions[i * 3 + 1]}" z="${m.positions[i * 3 + 2]}"/>`).join('') +
      '</vertices><triangles>' + Array.from({ length: m.indices.length / 3 }, (_, t) => `<triangle v1="${m.indices[t * 3]}" v2="${m.indices[t * 3 + 1]}" v3="${m.indices[t * 3 + 2]}"/>`).join('') + '</triangles></mesh>';
    const model = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
      <object id="1" type="model">${meshXml(cube(0, 20))}</object>
      <object id="2" type="other">${meshXml(cube(5, 5))}</object>
      <object id="3" type="model"><components><component objectid="1"/><component objectid="2"/></components></object>
      <object id="4" type="model">${meshXml(cube(0, 10))}</object>
      </resources><build><item objectid="3"/><item objectid="4" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></build></model>`;
    const cfg = '<config><object id="3"><metadata key="name" value="Body"/><part id="1" subtype="normal_part"></part><part id="2" subtype="negative_part"></part></object><object id="4"><metadata key="name" value="Stand"/></object></config>';
    const zip = new JSZip();
    zip.file('3D/3dmodel.model', model);
    zip.file('Metadata/model_settings.config', cfg);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const items = await parse3MFItems(buf);
    expect(items.map((i) => i.name)).toEqual(['Body', 'Stand']);
    expect(items[0].parts.length).toBe(1);
    expect(items[0].negatives.length).toBe(1);
    const { solid } = await toSolid(items[0].parts, items[0].negatives);
    expect(solid.volume()).toBeCloseTo(8000 - 125, 0);
    solid.delete();
  });
});
