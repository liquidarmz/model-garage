import type { Manifold } from 'manifold-3d';
import { type Plane, getKernel, splitSolid, solidBounds, polygonPerimeter, worldToPlane } from './geometry';
import { type CutSpec, newId, sectionAnchor } from './pipeline';
import { type PrinterProfile, fitsPrinterAnyOrientation } from './printers';
import type { Vec3 } from './mesh';
import { supportEstimate } from './orient';

export type PlanKind = 'fewest' | 'hidden' | 'easy';

export interface PlanPreset {
  kind: PlanKind;
  name: string;
  tagline: string;
  /** Split at natural necks this strong even when the part already fits. Infinity = only split to fit. */
  neckMin: number;
  maxParts: number;
  w: { neck: number; short: number; balance: number; room: number; flat: number };
}

export const PRESETS: PlanPreset[] = [
  {
    kind: 'hidden', name: 'Hidden seams', tagline: 'Cuts at natural narrow points like necks, wrists and waists.',
    neckMin: 0.3, maxParts: 6, w: { neck: 3, short: 1.5, balance: 0.6, room: 1, flat: 0.4 },
  },
  {
    kind: 'fewest', name: 'Fewest parts', tagline: 'Only cuts what it must to fit your printer.',
    neckMin: Infinity, maxParts: 12, w: { neck: 1.5, short: 1, balance: 1, room: 1, flat: 0.5 },
  },
  {
    kind: 'easy', name: 'Easy printing', tagline: 'Flat, level cuts so parts sit on the plate with fewer supports.',
    neckMin: 0.45, maxParts: 4, w: { neck: 1, short: 0.6, balance: 0.8, room: 1.2, flat: 2 },
  },
];

export interface Candidate {
  plane: Plane;
  axis: 0 | 1 | 2;
  t: number;
  area: number;
  perimeter: number;
  neck: number;
  balance: number; // smaller side's share of the volume, 0-0.5
  room: boolean; // a 5 mm connector fits
  score: number;
}

export interface SplitPlan {
  id: string;
  preset: PlanPreset;
  cuts: CutSpec[];
  partCount: number;
  allFit: boolean;
  scores: { hidden: number; printability: number; simplicity: number; overall: number };
  summary: string;
}

const AXIS_NAMES = ['side to side', 'front to back', 'top to bottom'];
const SAMPLES = 48;

/** Sample cross-sections along each axis and score every slice as a cut. */
export function findCandidates(solid: Manifold, preset: PlanPreset): Candidate[] {
  const b = solidBounds(solid);
  const out: Candidate[] = [];
  for (const axis of [0, 1, 2] as const) {
    const lo = b.min[axis], hi = b.max[axis], len = hi - lo;
    if (len < 4) continue;
    const normal: Vec3 = [0, 0, 0];
    normal[axis] = 1;
    const areas: number[] = [], perims: number[] = [], rooms: boolean[] = [], offs: number[] = [];
    // Rotate once per axis so the normal is +Z, then slice at each height.
    const local = axis === 2 ? solid : solid.transform(worldToPlane(normal) as never);
    for (let i = 0; i < SAMPLES; i++) {
      const off = lo + len * (0.04 + 0.92 * (i / (SAMPLES - 1)));
      const cs = local.slice(off);
      offs.push(off);
      areas.push(cs.area());
      perims.push(polygonPerimeter(cs));
      const inner = cs.offset(-(2.5 + 0.15 + 1.6), 'Round');
      rooms.push(!inner.isEmpty());
      inner.delete();
      cs.delete();
    }
    if (local !== solid) local.delete();
    const total = areas.reduce((s, a) => s + a, 0) || 1;
    const maxP = Math.max(...perims) || 1;
    let cum = 0;
    for (let i = 0; i < SAMPLES; i++) {
      cum += areas[i];
      if (areas[i] <= 0) continue;
      let leftMax = 0, rightMax = 0;
      for (let j = 0; j < i; j++) leftMax = Math.max(leftMax, areas[j]);
      for (let j = i + 1; j < SAMPLES; j++) rightMax = Math.max(rightMax, areas[j]);
      const ref = Math.min(leftMax, rightMax);
      const neck = ref > 0 ? Math.max(0, Math.min(1, 1 - areas[i] / ref)) : 0;
      const frac = (cum - areas[i] / 2) / total;
      const balance = Math.min(frac, 1 - frac);
      if (balance < 0.03) continue;
      const w = preset.w;
      const score =
        w.neck * neck +
        w.short * (1 - perims[i] / maxP) +
        w.balance * Math.min(1, balance * 4) +
        w.room * (rooms[i] ? 1 : 0) +
        w.flat * (axis === 2 ? 1 : 0);
      out.push({
        plane: { normal: [...normal] as Vec3, offset: offs[i] }, axis, t: (offs[i] - lo) / len,
        area: areas[i], perimeter: perims[i], neck, balance, room: rooms[i], score,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function size(s: Manifold): [number, number, number] {
  const b = solidBounds(s);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

function reasonsFor(c: Candidate): string[] {
  const r: string[] = [];
  if (c.neck > 0.3) r.push(`natural narrow point (${Math.round(c.neck * 100)}% thinner than around it)`);
  r.push(`${Math.round(c.perimeter)} mm seam`);
  if (c.axis === 2) r.push('level cut, prints flat on the plate');
  if (!c.room) r.push('too thin for connectors, glue only');
  return r;
}

/** Recursively split until parts fit and no strong necks remain. */
async function planSolid(
  solid: Manifold, preset: PlanPreset, printer: PrinterProfile, cuts: CutSpec[], budget: { parts: number },
  depth: number,
): Promise<void> {
  if (depth > 6) return;
  const sz = size(solid);
  const fits = fitsPrinterAnyOrientation(sz, printer);
  if (fits && (preset.neckMin === Infinity || budget.parts >= preset.maxParts)) return;
  const cands = findCandidates(solid, preset);
  let pick: Candidate | undefined;
  if (!fits) {
    // Must split: prefer cuts that shorten an axis that is too long.
    const limit = Math.max(...printer.volume) - 10;
    const over = sz.map((s) => s > Math.min(...printer.volume) - 10);
    pick = cands.find((c) => over[c.axis] && Math.max(c.t, 1 - c.t) * sz[c.axis] < Math.max(limit, sz[c.axis] * 0.75)) ??
      cands.find((c) => over[c.axis]) ?? cands[0];
  } else {
    pick = cands.find((c) => c.neck >= preset.neckMin && c.room);
  }
  if (!pick) return;
  const anchor = sectionAnchor(solid, pick.plane);
  if (!anchor) return;
  const [front, back] = splitSolid(solid, pick.plane);
  if (front.isEmpty() || back.isEmpty()) return;
  cuts.push({
    id: newId('cut'), plane: pick.plane, anchor, neck: pick.neck,
    reasons: [`Cut ${AXIS_NAMES[pick.axis]} at ${Math.round(pick.t * 100)}%`, ...reasonsFor(pick)],
  });
  budget.parts += 1;
  // Recurse into the larger half first so the budget goes where it matters.
  const halves = [front, back].sort((a, b) => b.volume() - a.volume());
  for (const h of halves) {
    await planSolid(h, preset, printer, cuts, budget, depth + 1);
    h.delete();
  }
}

/** Produce one plan per preset, scored, best first. */
export async function suggestPlans(solid: Manifold, printer: PrinterProfile): Promise<SplitPlan[]> {
  await getKernel();
  // Work on a lighter copy for speed; cuts are applied to the full model later.
  const tri = solid.numTri();
  const b = solidBounds(solid);
  const diag = Math.hypot(...b.max.map((v, k) => v - b.min[k]));
  const work = tri > 60000 ? solid.simplify(diag * 0.002) : solid;
  const plans: SplitPlan[] = [];
  for (const preset of PRESETS) {
    const cuts: CutSpec[] = [];
    await planSolid(work, preset, printer, cuts, { parts: 1 }, 0);
    plans.push(await scorePlan(work, preset, cuts, printer));
  }
  if (work !== solid) work.delete();
  // Drop duplicate plans (same cut count and nearly same planes).
  const unique: SplitPlan[] = [];
  for (const p of plans) {
    if (!unique.some((u) => samePlan(u, p))) unique.push(p);
  }
  return unique;
}

function samePlan(a: SplitPlan, b: SplitPlan): boolean {
  if (a.cuts.length !== b.cuts.length) return false;
  return a.cuts.every((c, i) => {
    const d = b.cuts[i];
    return c.plane.normal.every((v, k) => Math.abs(v - d.plane.normal[k]) < 1e-3) && Math.abs(c.plane.offset - d.plane.offset) < 1;
  });
}

export async function scorePlan(solid: Manifold, preset: PlanPreset, cuts: CutSpec[], printer: PrinterProfile): Promise<SplitPlan> {
  // Simulate the split (without connectors) to measure fit and supports.
  let parts: { s: Manifold; faces: Vec3[] }[] = [{ s: solid, faces: [] }];
  for (const c of cuts) {
    const idx = parts.findIndex((p) => {
      const bb = solidBounds(p.s);
      return c.anchor.every((v, k) => v >= bb.min[k] - 0.5 && v <= bb.max[k] + 0.5);
    });
    if (idx < 0) continue;
    const [f, bk] = splitSolid(parts[idx].s, c.plane);
    if (f.isEmpty() || bk.isEmpty()) continue;
    const n = c.plane.normal;
    parts.splice(idx, 1,
      { s: bk, faces: [...parts[idx].faces, n] },
      { s: f, faces: [...parts[idx].faces, [-n[0], -n[1], -n[2]]] });
  }
  parts = parts.flatMap((p) => p.s.decompose().map((s) => ({ s, faces: p.faces })));
  const allFit = parts.every((p) => fitsPrinterAnyOrientation(size(p.s), printer));
  let support = 0, area = 0;
  for (const p of parts) {
    const est = supportEstimate(p.s, p.faces[p.faces.length - 1]);
    support += est.overhangArea;
    area += est.totalArea;
  }
  for (const p of parts) if (p.s !== solid) p.s.delete();
  const supportFrac = area > 0 ? support / area : 0;
  const hidden = cuts.length ? cuts.reduce((s, c) => s + Math.min(1, c.neck / 0.6), 0) / cuts.length : 1;
  const printability = (allFit ? 1 : 0.3) * Math.max(0, 1 - supportFrac * 2.5);
  const simplicity = 1 / Math.sqrt(parts.length);
  const overall = Math.round(100 * (0.45 * hidden + 0.35 * printability + 0.2 * simplicity));
  const summary = cuts.length === 0
    ? 'No cuts needed: the whole model fits your printer.'
    : `${parts.length} parts, ${cuts.length} cut${cuts.length > 1 ? 's' : ''}${allFit ? ', every part fits your printer' : ', some parts are still too big'}.`;
  return {
    id: newId('plan'), preset, cuts, partCount: parts.length, allFit,
    scores: { hidden: Math.round(hidden * 100), printability: Math.round(printability * 100), simplicity: Math.round(simplicity * 100), overall },
    summary,
  };
}
