import type { Manifold } from 'manifold-3d';
import { fromSolid, solidBounds, normalize, cross, dot } from './geometry';
import { triangleNormalsAndAreas, type Vec3 } from './mesh';
import { type PrinterProfile, plateOrigin } from './printers';

/** Column-major 4x4 rotation taking unit vector a onto unit vector b. */
export function rotationBetween(a: Vec3, b: Vec3): number[] {
  const an = normalize(a), bn = normalize(b);
  const c = dot(an, bn);
  if (c > 1 - 1e-9) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  let axis: Vec3;
  let angle: number;
  if (c < -1 + 1e-9) {
    axis = Math.abs(an[0]) < 0.9 ? normalize(cross(an, [1, 0, 0])) : normalize(cross(an, [0, 1, 0]));
    angle = Math.PI;
  } else {
    axis = normalize(cross(an, bn));
    angle = Math.acos(c);
  }
  const [x, y, z] = axis;
  const s = Math.sin(angle), co = Math.cos(angle), t = 1 - co;
  return [
    t * x * x + co, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + co, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + co, 0,
    0, 0, 0, 1,
  ];
}

/** Rotate so the given outward face normal points down (onto the plate). */
export function faceDown(solid: Manifold, outward?: Vec3): Manifold {
  const rotated = outward ? solid.transform(rotationBetween(outward, [0, 0, -1]) as never) : solid;
  const b = solidBounds(rotated);
  const out = rotated.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]);
  if (rotated !== solid) rotated.delete();
  return out;
}

/**
 * Rough support need: area of faces pointing down more than 45 degrees,
 * ignoring faces resting on the plate, with the part placed `outward` down.
 */
export function supportEstimate(solid: Manifold, outward?: Vec3): { overhangArea: number; totalArea: number } {
  const placed = faceDown(solid, outward);
  const mesh = fromSolid(placed);
  placed.delete();
  const { normals, areas, centroids } = triangleNormalsAndAreas(mesh);
  let over = 0, total = 0;
  for (let t = 0; t < areas.length; t++) {
    total += areas[t];
    if (centroids[t * 3 + 2] < 0.3) continue;
    if (-normals[t * 3 + 2] > Math.SQRT1_2) over += areas[t];
  }
  return { overhangArea: over, totalArea: total };
}

export interface PlacedPart {
  id: string;
  solid: Manifold; // already oriented and positioned in plate coordinates
  plate: number;
}

/**
 * Orient each part with its largest cut face down, then pack parts onto
 * plates in rows (simple shelf packing, 6 mm gaps).
 */
export function layoutOnPlates(
  parts: { id: string; solid: Manifold; faces: { normal: Vec3; area: number }[] }[],
  printer: PrinterProfile,
): PlacedPart[] {
  const gap = 6;
  const [W, D] = printer.volume;
  const oriented = parts.map((p) => {
    const face = [...p.faces].sort((a, b) => b.area - a.area)[0];
    let s = faceDown(p.solid, face?.normal);
    let b = solidBounds(s);
    // Turn 90 degrees if that makes the footprint fit the plate.
    if (b.max[0] - b.min[0] > W - 10 && b.max[1] - b.min[1] <= W - 10) {
      s = s.rotate([0, 0, 90]);
      b = solidBounds(s);
    }
    return { id: p.id, s, w: b.max[0] - b.min[0], d: b.max[1] - b.min[1] };
  }).sort((a, b) => b.d - a.d);

  const slots: { o: (typeof oriented)[number]; x: number; y: number; plate: number }[] = [];
  let plate = 0, x = gap, y = gap, rowD = 0;
  for (const o of oriented) {
    if (x + o.w > W - gap && x > gap) { x = gap; y += rowD + gap; rowD = 0; }
    if (y + o.d > D - gap && y > gap) { plate += 1; x = gap; y = gap; rowD = 0; }
    slots.push({ o, x, y, plate });
    x += o.w + gap;
    rowD = Math.max(rowD, o.d);
  }
  const count = plate + 1;
  return slots.map(({ o, x: sx, y: sy, plate: pl }) => {
    const b = solidBounds(o.s);
    const [ox, oy] = plateOrigin(pl, count, printer);
    const s = o.s.translate([sx - b.min[0] + ox, sy - b.min[1] + oy, 0]);
    o.s.delete();
    return { id: o.id, solid: s, plate: pl };
  });
}
