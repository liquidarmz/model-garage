import type { Manifold } from 'manifold-3d';
import { type Plane, getKernel, splitSolid, sectionAt, planeBasis, solidBounds, dot } from './geometry';
import { type ConnectorSettings, addConnectors, sectionShape } from './connectors';
import type { Vec3 } from './mesh';

export interface CutSpec {
  id: string;
  plane: Plane;
  /** A point on the cut face; used to find which part this cut applies to. */
  anchor: Vec3;
  reasons: string[];
  /** 0-1, how much the model narrows here (1 = strong natural seam). */
  neck: number;
  /** Per-seam connector override. */
  connector?: ConnectorSettings;
}

export interface CutFace {
  /** Outward normal of the flat cut face on this part. */
  normal: Vec3;
  area: number;
  cutId: string;
}

export interface BuiltPart {
  id: string;
  name: string;
  kind: 'part' | 'pin';
  solid: Manifold;
  faces: CutFace[];
}

export interface BuildResult {
  parts: BuiltPart[];
  warnings: string[];
  connectorsPlaced: number;
}

let counter = 0;
export function newId(prefix: string) {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

function contains(b: { min: Vec3; max: Vec3 }, p: Vec3, pad: number) {
  return p.every((v, k) => v >= b.min[k] - pad && v <= b.max[k] + pad);
}

/**
 * Apply cuts in order. Each cut splits the one part its anchor sits in.
 * When `connectors` is given, connectors are added at each seam as it is cut.
 */
export async function buildParts(
  base: Manifold,
  cuts: CutSpec[],
  connectors: ConnectorSettings | null,
): Promise<BuildResult> {
  await getKernel();
  let parts: BuiltPart[] = [{ id: 'p0', name: 'Part 1', kind: 'part', solid: base, faces: [] }];
  const warnings: string[] = [];
  let connectorsPlaced = 0;
  let pinCount = 0;
  for (const cut of cuts) {
    const n = cut.plane.normal;
    // Prefer the part whose bounds contain the anchor; fall back to any part the plane crosses.
    const ordered = [...parts.filter((p) => p.kind === 'part')].sort((a, b) => {
      const ca = contains(solidBounds(a.solid), cut.anchor, 0.5) ? 0 : 1;
      const cb = contains(solidBounds(b.solid), cut.anchor, 0.5) ? 0 : 1;
      return ca - cb;
    });
    let done = false;
    for (const target of ordered) {
      const b = solidBounds(target.solid);
      if (!contains(b, cut.anchor, 0.5)) continue;
      let [front, back] = splitSolid(target.solid, cut.plane);
      if (front.isEmpty() || back.isEmpty()) continue;
      const section = sectionAt(target.solid, cut.plane);
      const area = section.area();
      // A plane can cut through several disconnected regions of the part; only
      // keep the region at the anchor in this seam and leave the rest joined.
      const settings = cut.connector ?? connectors;
      if (settings && settings.type !== 'none') {
        const res = await addConnectors(back, front, cut.plane, settings, section);
        back = res.back;
        front = res.front;
        connectorsPlaced += res.placed;
        if (res.warning) warnings.push(res.warning);
        for (const pin of res.extras) {
          pinCount += 1;
          parts.push({ id: newId('pin'), name: `Pin ${pinCount}`, kind: 'pin', solid: pin, faces: [] });
        }
      }
      const backPart: BuiltPart = {
        id: newId('p'), name: '', kind: 'part', solid: back,
        faces: [...target.faces, { normal: [...n] as Vec3, area, cutId: cut.id }],
      };
      const frontPart: BuiltPart = {
        id: newId('p'), name: '', kind: 'part', solid: front,
        faces: [...target.faces, { normal: [-n[0], -n[1], -n[2]], area, cutId: cut.id }],
      };
      // Faces from earlier cuts only stay with the half that still touches them.
      for (const p of [backPart, frontPart]) {
        const pb = solidBounds(p.solid);
        p.faces = p.faces.filter((f) => f.cutId === cut.id || touchesFace(pb, f, cuts));
      }
      parts = parts.flatMap((p) => (p === target ? [backPart, frontPart] : [p]));
      done = true;
      break;
    }
    if (!done) warnings.push('One suggested cut no longer crosses the model and was skipped.');
  }
  // Split any part that came apart into separate islands (e.g. two arms cut by one plane).
  const final: BuiltPart[] = [];
  for (const p of parts) {
    if (p.kind !== 'part') { final.push(p); continue; }
    const islands = p.solid.decompose();
    if (islands.length <= 1) final.push(p);
    else for (const s of islands) {
      const sb = solidBounds(s);
      final.push({ id: newId('p'), name: '', kind: 'part', solid: s, faces: p.faces.filter((f) => touchesFace(sb, f, cuts)) });
    }
  }
  let i = 0;
  for (const p of final) if (p.kind === 'part') p.name = `Part ${++i}`;
  return { parts: final, warnings: [...new Set(warnings)], connectorsPlaced };
}

function touchesFace(b: { min: Vec3; max: Vec3 }, f: CutFace, cuts: CutSpec[]): boolean {
  const cut = cuts.find((c) => c.id === f.cutId);
  if (!cut) return false;
  // The part touches the plane if the plane passes within its bounds.
  const n = cut.plane.normal;
  let lo = 0, hi = 0;
  for (let k = 0; k < 3; k++) {
    lo += n[k] * (n[k] >= 0 ? b.min[k] : b.max[k]);
    hi += n[k] * (n[k] >= 0 ? b.max[k] : b.min[k]);
  }
  return cut.plane.offset >= lo - 0.2 && cut.plane.offset <= hi + 0.2;
}

/** World-space centroid of a section, used as a cut's anchor. */
export function sectionAnchor(solid: Manifold, plane: Plane): Vec3 | null {
  const cs = sectionAt(solid, plane);
  if (cs.isEmpty()) return null;
  const { centroid } = sectionShape(cs);
  const { u, v, n } = planeBasis(plane.normal);
  return [0, 1, 2].map((k) => u[k] * centroid[0] + v[k] * centroid[1] + n[k] * plane.offset) as Vec3;
}

/** Move a cut along its normal, keeping its anchor on the plane. */
export function shiftCut(cut: CutSpec, newOffset: number): CutSpec {
  const d = newOffset - cut.plane.offset;
  const n = cut.plane.normal;
  return { ...cut, plane: { ...cut.plane, offset: newOffset }, anchor: [cut.anchor[0] + n[0] * d, cut.anchor[1] + n[1] * d, cut.anchor[2] + n[2] * d] };
}

/** Tilt a cut about an axis lying in its plane through the anchor. */
export function tiltCut(cut: CutSpec, axis: Vec3, degrees: number): CutSpec {
  const a = (degrees * Math.PI) / 180;
  const n = cut.plane.normal;
  const k = axis;
  const cosA = Math.cos(a), sinA = Math.sin(a);
  const kxn: Vec3 = [k[1] * n[2] - k[2] * n[1], k[2] * n[0] - k[0] * n[2], k[0] * n[1] - k[1] * n[0]];
  const kd = dot(k, n);
  const nn: Vec3 = [0, 1, 2].map((i) => n[i] * cosA + kxn[i] * sinA + k[i] * kd * (1 - cosA)) as Vec3;
  return { ...cut, plane: { normal: nn, offset: dot(nn, cut.anchor) } };
}
