import Module from 'manifold-3d';
import type { ManifoldToplevel, Manifold, CrossSection } from 'manifold-3d';
import { type TriMesh, type Vec3, weld, flipWinding, analyzeMesh } from './mesh';

let wasmPromise: Promise<ManifoldToplevel> | null = null;
let locateFileOverride: (() => string) | undefined;

/** Browser builds set this to the bundled .wasm URL before first use. */
export function setWasmLocator(fn: () => string) {
  locateFileOverride = fn;
}

export function getKernel(): Promise<ManifoldToplevel> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const wasm = await Module(locateFileOverride ? { locateFile: locateFileOverride } : undefined);
      wasm.setup();
      return wasm;
    })();
  }
  return wasmPromise;
}

export type { Manifold, CrossSection };

/** A cutting plane: points x with dot(normal, x) = offset. Normal is unit length. */
export interface Plane {
  normal: Vec3;
  offset: number;
}

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Orthonormal basis (u, v, n) for a plane normal; u and v span the cut face. */
export function planeBasis(n: Vec3): { u: Vec3; v: Vec3; n: Vec3 } {
  const nn = normalize(n);
  const helper: Vec3 = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(helper, nn));
  const v = cross(nn, u);
  return { u, v, n: nn };
}

/** Column-major matrix taking world coords into plane-local coords (u, v, n). */
export function worldToPlane(n: Vec3): number[] {
  const { u, v, n: w } = planeBasis(n);
  return [u[0], v[0], w[0], 0, u[1], v[1], w[1], 0, u[2], v[2], w[2], 0, 0, 0, 0, 1];
}

/** Column-major matrix taking plane-local coords (x along u, y along v, z along n) to world, origin at plane. */
export function planeToWorld(p: Plane): number[] {
  const { u, v, n } = planeBasis(p.normal);
  const o: Vec3 = [n[0] * p.offset, n[1] * p.offset, n[2] * p.offset];
  return [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, o[0], o[1], o[2], 1];
}

export interface SolidResult {
  solid: Manifold;
  repaired: string[];
}

/**
 * Turn a triangle mesh into a watertight solid. Tries progressively stronger
 * fixes: merge nearby vertices, flip if inside out, then a looser weld.
 */
export async function toSolid(mesh: TriMesh): Promise<SolidResult> {
  const wasm = await getKernel();
  const repaired: string[] = [];
  const attempt = (m: TriMesh): Manifold | null => {
    try {
      const mm = new wasm.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices });
      mm.merge();
      const solid = new wasm.Manifold(mm);
      if (solid.status() !== 'NoError' || solid.isEmpty()) { solid.delete(); return null; }
      return solid;
    } catch {
      return null;
    }
  };
  let m = mesh;
  const health = analyzeMesh(m);
  if (health.volume < 0) {
    m = flipWinding(m);
    repaired.push('Turned inside-out faces the right way');
  }
  let solid = attempt(m);
  if (!solid) {
    for (const tol of [1e-3, 1e-2, 5e-2]) {
      const welded = weld(m.positions, m.indices, tol);
      solid = attempt(welded);
      if (solid) {
        repaired.push(`Closed tiny gaps (merged points within ${tol} mm)`);
        break;
      }
    }
  }
  if (!solid) throw new Error('This model has holes or overlapping surfaces that could not be fixed automatically.');
  const parts = solid.decompose();
  if (parts.length > 1) {
    // Drop specks that are almost certainly noise (< 0.1% of total volume).
    const total = solid.volume();
    const keep = parts.filter((p) => p.volume() > total * 0.001);
    if (keep.length < parts.length) {
      repaired.push(`Removed ${parts.length - keep.length} loose speck${parts.length - keep.length > 1 ? 's' : ''}`);
      const old = solid;
      solid = wasm.Manifold.union(keep);
      old.delete();
    }
  }
  for (const p of parts) p.delete();
  return { solid, repaired };
}

export function fromSolid(solid: Manifold): TriMesh {
  const m = solid.getMesh();
  const np = m.numProp;
  let positions: Float32Array;
  if (np === 3) positions = new Float32Array(m.vertProperties);
  else {
    const n = m.vertProperties.length / np;
    positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = m.vertProperties[i * np];
      positions[i * 3 + 1] = m.vertProperties[i * np + 1];
      positions[i * 3 + 2] = m.vertProperties[i * np + 2];
    }
  }
  return { positions, indices: new Uint32Array(m.triVerts) };
}

/** Cross-section of a solid on a plane, in plane-local 2D coords (u, v). */
export function sectionAt(solid: Manifold, plane: Plane): CrossSection {
  const local = solid.transform(worldToPlane(plane.normal) as never);
  const cs = local.slice(plane.offset);
  local.delete();
  return cs;
}

/** Split into [front, back]: front is on the side the normal points to. */
export function splitSolid(solid: Manifold, plane: Plane): [Manifold, Manifold] {
  const [a, b] = solid.splitByPlane(plane.normal, plane.offset);
  return [a, b];
}

export function polygonPerimeter(cs: CrossSection): number {
  let total = 0;
  for (const poly of cs.toPolygons()) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  return total;
}

export function solidBounds(s: Manifold): { min: Vec3; max: Vec3 } {
  const b = s.boundingBox();
  return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
}
