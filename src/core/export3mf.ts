import JSZip from 'jszip';
import type { TriMesh } from './mesh';

export interface ExportObject {
  name: string;
  mesh: TriMesh; // in plate coordinates (mm)
  /** Per-triangle filament slot, 0-based. Omit for a single-color part. */
  colors?: Uint8Array;
  /** Slot for the whole object when `colors` is omitted. */
  slot?: number;
}

/**
 * Bambu Studio / Orca / PrusaSlicer store painted filament per triangle as a
 * small hex code: extruder 1 = "4", 2 = "8", 3+ = (n-3) in hex followed by "C".
 */
export function paintCode(slot: number): string {
  const n = slot + 1;
  if (n <= 0) return '';
  if (n === 1) return '4';
  if (n === 2) return '8';
  return (n - 3).toString(16).toUpperCase() + 'C';
}

function hexColor(c: string): string {
  const h = c.replace('#', '').toUpperCase();
  return '#' + (h.length === 6 ? h + 'FF' : h);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export function build3mfModel(objects: ExportObject[], palette: string[]): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">');
  out.push(' <metadata name="Application">Model Garage</metadata>');
  out.push(' <resources>');
  out.push('  <basematerials id="1">');
  palette.forEach((c, i) => out.push(`   <base name="Filament ${i + 1}" displaycolor="${hexColor(c)}"/>`));
  out.push('  </basematerials>');
  const centers: [number, number, number][] = [];
  objects.forEach((o, i) => {
    const id = i + 2;
    const objSlot = o.slot ?? (o.colors ? mostCommon(o.colors) : 0);
    out.push(`  <object id="${id}" type="model" name="${esc(o.name)}" pid="1" pindex="${objSlot}">`);
    out.push('   <mesh>');
    out.push('    <vertices>');
    // Slicers place each object by its build-item transform, so store the mesh
    // around its own center and move it into position with the transform.
    const p = o.mesh.positions;
    const c = meshCenter(p);
    centers.push(c);
    const lines: string[] = [];
    for (let v = 0; v < p.length; v += 3) lines.push(`     <vertex x="${fmt(p[v] - c[0])}" y="${fmt(p[v + 1] - c[1])}" z="${fmt(p[v + 2] - c[2])}"/>`);
    out.push(lines.join('\n'));
    out.push('    </vertices>');
    out.push('    <triangles>');
    const idx = o.mesh.indices;
    const tl: string[] = [];
    for (let t = 0; t < idx.length / 3; t++) {
      const slot = o.colors ? o.colors[t] : objSlot;
      let extra = '';
      if (slot !== objSlot) extra += ` pid="1" p1="${slot}"`;
      if (o.colors && slot > 0) {
        const code = paintCode(slot);
        extra += ` paint_color="${code}" slic3rpe:mmu_segmentation="${code}"`;
      }
      tl.push(`     <triangle v1="${idx[t * 3]}" v2="${idx[t * 3 + 1]}" v3="${idx[t * 3 + 2]}"${extra}/>`);
    }
    out.push(tl.join('\n'));
    out.push('    </triangles>');
    out.push('   </mesh>');
    out.push('  </object>');
  });
  out.push(' </resources>');
  out.push(' <build>');
  objects.forEach((_, i) => {
    const [x, y, z] = centers[i];
    out.push(`  <item objectid="${i + 2}" transform="1 0 0 0 1 0 0 0 1 ${fmt(x)} ${fmt(y)} ${fmt(z)}" printable="1"/>`);
  });
  out.push(' </build>');
  out.push('</model>');
  return out.join('\n');
}

/** Center of the bounding box in X/Y; Z stays at the base so parts sit on the plate. */
function meshCenter(p: Float32Array): [number, number, number] {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
    if (p[i + 2] < z0) z0 = p[i + 2];
  }
  return p.length ? [(x0 + x1) / 2, (y0 + y1) / 2, z0] : [0, 0, 0];
}

function mostCommon(a: Uint8Array): number {
  const counts = new Map<number, number>();
  for (const v of a) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 0, bc = -1;
  for (const [k, c] of counts) if (c > bc) { bc = c; best = k; }
  return best;
}

export async function export3mf(objects: ExportObject[], palette: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  zip.file('3D/3dmodel.model', build3mfModel(objects, palette));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
