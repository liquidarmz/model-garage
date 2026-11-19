import type { ManifoldToplevel, Manifold, CrossSection } from 'manifold-3d';
import { type Plane, getKernel, planeToWorld, sectionAt } from './geometry';

export type ConnectorType = 'none' | 'dowel' | 'pin' | 'socket' | 'dovetail' | 'snap' | 'magnet';

export const CONNECTOR_INFO: Record<ConnectorType, { label: string; blurb: string }> = {
  none: { label: 'None', blurb: 'Flat faces. Glue only.' },
  dowel: { label: 'Dowel', blurb: 'Holes in both parts plus a separate pin. Strongest alignment.' },
  pin: { label: 'Pin', blurb: 'A peg on one part, a hole in the other. No loose bits.' },
  socket: { label: 'Socket', blurb: 'A wide, short plug. Good for big flat seams.' },
  dovetail: { label: 'Dovetail', blurb: 'A rail that slides in sideways and locks.' },
  snap: { label: 'Snap', blurb: 'Split peg with a barb that clicks in. Glue-free.' },
  magnet: { label: 'Magnet', blurb: 'Pockets for 6 x 3 mm magnets. Removable parts.' },
};

export interface ConnectorSettings {
  type: ConnectorType;
  /** Peg/hole diameter in mm. 0 = auto from seam size. */
  diameter: number;
  /** Extra gap added to holes, in mm. */
  clearance: number;
  /** How many connectors per seam. 0 = auto. */
  count: number;
  /** Minimum wall between a connector and the outside surface, mm. */
  wall: number;
  magnet: { diameter: number; height: number };
}

export const DEFAULT_CONNECTOR: ConnectorSettings = {
  type: 'dowel',
  diameter: 0,
  clearance: 0.15,
  count: 0,
  wall: 1.6,
  magnet: { diameter: 6, height: 3 },
};

export interface ConnectorResult {
  /** Part on the back side of the plane (normal points away from it). */
  back: Manifold;
  /** Part on the front side of the plane. */
  front: Manifold;
  /** Loose pieces to print separately (dowel pins). */
  extras: Manifold[];
  placed: number;
  diameter: number;
  warning?: string;
}

type Pt = [number, number];

function pointInPolys(p: Pt, polys: Pt[][]): boolean {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Area centroid and principal axis of a cross-section. */
export function sectionShape(cs: CrossSection): { centroid: Pt; axis: Pt; extent: number; width: number } {
  let A = 0, cx = 0, cy = 0;
  const polys = cs.toPolygons() as Pt[][];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
      const c = x0 * y1 - x1 * y0;
      A += c;
      cx += (x0 + x1) * c;
      cy += (y0 + y1) * c;
    }
  }
  A /= 2;
  const centroid: Pt = A !== 0 ? [cx / (6 * A), cy / (6 * A)] : [0, 0];
  // Principal axis from vertex covariance (good enough for placement).
  let sxx = 0, syy = 0, sxy = 0, n = 0;
  for (const poly of polys) for (const [x, y] of poly) {
    const dx = x - centroid[0], dy = y - centroid[1];
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy; n++;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const axis: Pt = [Math.cos(ang), Math.sin(ang)];
  let lo = Infinity, hi = -Infinity, wlo = Infinity, whi = -Infinity;
  for (const poly of polys) for (const [x, y] of poly) {
    const dx = x - centroid[0], dy = y - centroid[1];
    const t = dx * axis[0] + dy * axis[1];
    const s = -dx * axis[1] + dy * axis[0];
    lo = Math.min(lo, t); hi = Math.max(hi, t);
    wlo = Math.min(wlo, s); whi = Math.max(whi, s);
  }
  return { centroid, axis, extent: hi - lo, width: whi - wlo };
}

/** Pick connector centers inside the section, keeping `margin` from the edge. */
export function pickPoints(cs: CrossSection, margin: number, count: number): Pt[] {
  const inner = cs.offset(-margin, 'Round');
  if (inner.isEmpty()) return [];
  const comps = inner.decompose().sort((a, b) => b.area() - a.area());
  const pts: Pt[] = [];
  for (const comp of comps) {
    if (pts.length >= Math.max(count, 1)) break;
    const polys = comp.toPolygons() as Pt[][];
    const shape = sectionShape(comp);
    const want = count === 0 ? (shape.extent > margin * 6 ? 2 : 1) : count - pts.length;
    const candidates: Pt[] = [];
    if (want >= 2) {
      for (let k = 0; k < want; k++) {
        const t = (k / (want - 1) - 0.5) * shape.extent * 0.6;
        candidates.push([shape.centroid[0] + shape.axis[0] * t, shape.centroid[1] + shape.axis[1] * t]);
      }
    } else candidates.push(shape.centroid);
    for (const c of candidates) {
      if (pointInPolys(c, polys)) pts.push(c);
    }
    if (!pts.length) {
      // Concave shape: centroid falls outside. Use the vertex nearest to it.
      let best: Pt | null = null, bd = Infinity;
      for (const poly of polys) for (const p of poly) {
        const d = Math.hypot(p[0] - shape.centroid[0], p[1] - shape.centroid[1]);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) pts.push(best);
    }
    if (count === 0) break; // auto: one component is enough
  }
  return pts;
}

/** Auto diameter: scales with the seam, 3-10 mm. */
export function autoDiameter(cs: CrossSection): number {
  const s = sectionShape(cs);
  const minDim = Math.min(s.extent, s.width);
  return Math.max(3, Math.min(10, Math.round(minDim * 0.25 * 2) / 2));
}

/**
 * Add connectors across one cut. `back`/`front` are the two halves from
 * splitting along `plane`; `section` is the cut face (plane-local 2D).
 */
export async function addConnectors(
  back: Manifold,
  front: Manifold,
  plane: Plane,
  settings: ConnectorSettings,
  section?: CrossSection,
): Promise<ConnectorResult> {
  const wasm = await getKernel();
  const cs = section ?? sectionAt(back, { normal: plane.normal, offset: plane.offset - 0.01 });
  if (settings.type === 'none' || cs.isEmpty()) {
    return { back, front, extras: [], placed: 0, diameter: 0 };
  }
  let d = settings.diameter > 0 ? settings.diameter : autoDiameter(cs);
  if (settings.type === 'magnet') d = settings.magnet.diameter;
  if (settings.type === 'socket') d = d * 1.6;
  const toWorld = planeToWorld(plane) as never;
  const c = settings.clearance;

  if (settings.type === 'dovetail') return dovetail(wasm, back, front, cs, d, c, toWorld);

  let pts: Pt[] = [];
  let warning: string | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    pts = pickPoints(cs, d / 2 + c + settings.wall, settings.count);
    if (pts.length) break;
    if (settings.type === 'magnet') break;
    d = Math.max(2, d * 0.7);
  }
  if (!pts.length) {
    return { back, front, extras: [], placed: 0, diameter: 0, warning: 'Seam too thin for a connector; it will need glue.' };
  }
  if (settings.diameter > 0 && Math.abs(d - settings.diameter) > 0.01 && settings.type !== 'magnet') {
    warning = `Shrunk to ${d.toFixed(1)} mm to fit this seam.`;
  }
  const r = d / 2;
  const depth = Math.max(4, Math.min(12, d * 1.5));
  const seg = 32;
  const addBack: Manifold[] = [];
  const cutBack: Manifold[] = [];
  const cutFront: Manifold[] = [];
  const extras: Manifold[] = [];

  for (const [x, y] of pts) {
    const at = (m: Manifold) => m.translate([x, y, 0]);
    switch (settings.type) {
      case 'dowel': {
        const hole = wasm.Manifold.cylinder(depth * 2 + 0.4, r + c, r + c, seg, true);
        cutBack.push(at(hole));
        cutFront.push(at(hole));
        const pinLen = depth * 2 - 0.6;
        const cham = Math.min(0.5, r * 0.3);
        const pin = wasm.Manifold.cylinder(cham, r - cham, r, seg)
          .add(wasm.Manifold.cylinder(pinLen - 2 * cham, r, r, seg).translate([0, 0, cham]))
          .add(wasm.Manifold.cylinder(cham, r, r - cham, seg).translate([0, 0, pinLen - cham]));
        extras.push(pin);
        break;
      }
      case 'pin': {
        const len = depth - 0.3;
        const cham = Math.min(0.6, r * 0.3);
        const peg = wasm.Manifold.cylinder(len - cham + 0.01, r, r, seg)
          .add(wasm.Manifold.cylinder(cham, r, r - cham, seg).translate([0, 0, len - cham]))
          .translate([0, 0, -0.01]);
        addBack.push(at(peg));
        cutFront.push(at(wasm.Manifold.cylinder(depth + 0.01, r + c, r + c, seg).translate([0, 0, -0.01])));
        break;
      }
      case 'socket': {
        const h = Math.max(2, depth * 0.5);
        addBack.push(at(wasm.Manifold.cylinder(h + 0.01, r, r * 0.95, seg * 2).translate([0, 0, -0.01])));
        cutFront.push(at(wasm.Manifold.cylinder(h + 0.31, r + c, r * 0.95 + c, seg * 2).translate([0, 0, -0.01])));
        break;
      }
      case 'snap': {
        const len = depth;
        const barb = Math.max(0.35, r * 0.18);
        const body = wasm.Manifold.cylinder(len - 1.6 + 0.01, r, r, seg).translate([0, 0, -0.01]);
        const lip = wasm.Manifold.cylinder(0.8, r, r + barb, seg).translate([0, 0, len - 1.6])
          .add(wasm.Manifold.cylinder(0.8, r + barb, r * 0.7, seg).translate([0, 0, len - 0.8]));
        const slot = wasm.Manifold.cube([r * 2 + barb * 2 + 1, Math.max(0.8, r * 0.45), len * 0.7], false)
          .translate([-(r + barb + 0.5), -Math.max(0.8, r * 0.45) / 2, len * 0.3 + 0.01]);
        addBack.push(at(body.add(lip).subtract(slot)));
        const bore = wasm.Manifold.cylinder(len + 0.3, r + c, r + c, seg).translate([0, 0, -0.01]);
        const undercut = wasm.Manifold.cylinder(1.0, r + barb + c, r + barb + c, seg).translate([0, 0, len - 1.6 + 0.2]);
        cutFront.push(at(bore.add(undercut)));
        break;
      }
      case 'magnet': {
        const mh = settings.magnet.height / 2 + 0.2;
        const pocket = (dir: 1 | -1) => wasm.Manifold.cylinder(mh + 0.01, r + c, r + c, seg)
          .translate([0, 0, dir > 0 ? -0.01 : -mh]);
        cutFront.push(at(pocket(1)));
        cutBack.push(at(pocket(-1)));
        break;
      }
    }
  }
  const place = (list: Manifold[]) => {
    const u = wasm.Manifold.union(list);
    const out = u.transform(toWorld);
    u.delete();
    for (const m of new Set(list)) m.delete();
    return out;
  };
  // Apply a boolean, freeing the tool and any intermediate (never the caller's inputs).
  const apply = (cur: Manifold, orig: Manifold, op: 'add' | 'subtract', tool: Manifold) => {
    const next = cur[op](tool);
    tool.delete();
    if (cur !== orig) cur.delete();
    return next;
  };
  let newBack = back, newFront = front;
  if (addBack.length) newBack = apply(newBack, back, 'add', place(addBack));
  if (cutBack.length) newBack = apply(newBack, back, 'subtract', place(cutBack));
  if (cutFront.length) newFront = apply(newFront, front, 'subtract', place(cutFront));
  return { back: newBack, front: newFront, extras, placed: pts.length, diameter: d, warning };
}

function dovetail(
  wasm: ManifoldToplevel, back: Manifold, front: Manifold, cs: CrossSection,
  d: number, c: number, toWorld: never,
): ConnectorResult {
  const shape = sectionShape(cs);
  const width = Math.max(3, Math.min(d * 1.2, shape.width * 0.35));
  const h = Math.max(2.5, Math.min(8, width * 0.7));
  const flare = width * 0.3;
  const len = shape.extent * 3 + 20;
  // Trapezoid in (y, z), extruded along x, then rotated to the section's long axis.
  const trap = (grow: number) => new wasm.CrossSection([[
    [-width / 2 - grow, -0.01], [width / 2 + grow, -0.01],
    [width / 2 + flare + grow, h + grow], [-width / 2 - flare - grow, h + grow],
  ]]);
  // Extrude in z then rotate so the profile lies in the (v, n) plane and runs along u.
  const prism = (grow: number) => wasm.Manifold.extrude(trap(grow), len, 0, 0, [1, 1], true)
    .rotate([90, 0, 90]);
  const angle = (Math.atan2(shape.axis[1], shape.axis[0]) * 180) / Math.PI;
  const orient = (m: Manifold) => m.rotate([0, 0, angle]).translate([shape.centroid[0], shape.centroid[1], 0]);
  // The rail must stop at the part surface: clip it to the cut face shrunk by a hair.
  const footprint = cs.offset(-0.4, 'Round');
  if (footprint.isEmpty()) return { back, front, extras: [], placed: 0, diameter: 0, warning: 'Seam too thin for a dovetail.' };
  const clip = footprint.extrude(h + 1).translate([0, 0, -0.5]);
  const rail = orient(prism(0)).intersect(clip);
  const slot = orient(prism(c));
  return {
    back: back.add(rail.transform(toWorld)),
    front: front.subtract(slot.transform(toWorld)),
    extras: [],
    placed: 1,
    diameter: width,
  };
}
