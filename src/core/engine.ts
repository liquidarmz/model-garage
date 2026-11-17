import type { Manifold } from 'manifold-3d';
import { toSolid, fromSolid, solidBounds, getKernel, type Plane } from './geometry';
import { loadModel } from './loaders';
import { type TriMesh, type MeshHealth, analyzeMesh, type Vec3 } from './mesh';
import type { PrinterProfile } from './printers';
import { type SplitPlan, suggestPlans } from './smartcut';
import { type CutSpec, type CutFace, type BuiltPart, buildParts, sectionAnchor } from './pipeline';
import type { ConnectorSettings } from './connectors';
import { layoutOnPlates } from './orient';
import { sampleFigure } from './samples';

export interface Bounds { min: Vec3; max: Vec3 }

/** A part as plain data (safe to send between threads). */
export interface PartData {
  id: string;
  name: string;
  kind: 'part' | 'pin';
  mesh: TriMesh;
  faces: CutFace[];
  bounds: Bounds;
}

export interface BaseData {
  fileName: string;
  health: MeshHealth;
  repairs: string[];
  bounds: Bounds;
  part: PartData;
}

export interface BuildData {
  parts: PartData[];
  warnings: string[];
  connectorsPlaced: number;
}

export interface PlacedData {
  id: string;
  plate: number;
  mesh: TriMesh;
}

export type Progress = (label: string) => void;

/**
 * Owns every Manifold object for one open model. All geometry work goes
 * through here so solids are created and freed in one place (WASM memory is
 * not garbage collected). In the app this runs inside a Web Worker.
 */
export class GeometryEngine {
  private base: Manifold | null = null;
  private parts: BuiltPart[] = [];
  private fileName = 'Model';
  private repairs: string[] = [];
  progress: Progress = () => {};

  async load(name: string, buffer: ArrayBuffer): Promise<BaseData> {
    this.progress(`Reading ${name}`);
    const mesh = await loadModel(name, buffer);
    this.progress(`Checking and repairing ${(mesh.indices.length / 3).toLocaleString()} triangles`);
    const { solid, repaired } = await toSolid(mesh);
    return this.setBase(solid, name, repaired);
  }

  async sample(height = 300): Promise<BaseData> {
    this.progress('Building the sample figure');
    return this.setBase(await sampleFigure(height), `Sample figure (${height} mm)`, []);
  }

  async scale(factor: number): Promise<BaseData> {
    const base = this.need();
    return this.setBase(base.scale([factor, factor, factor]), this.fileName, []);
  }

  async mirror(axis: 0 | 1 | 2): Promise<BaseData> {
    const base = this.need();
    const n: Vec3 = [0, 0, 0];
    n[axis] = 1;
    return this.setBase(base.mirror(n), this.fileName, this.repairs);
  }

  async suggest(printer: PrinterProfile): Promise<SplitPlan[]> {
    this.progress('Finding the best places to cut');
    return suggestPlans(this.need(), printer);
  }

  async anchor(plane: Plane): Promise<Vec3 | null> {
    return sectionAnchor(this.need(), plane);
  }

  async build(cuts: CutSpec[], connectors: ConnectorSettings | null): Promise<BuildData> {
    const base = this.need();
    this.progress(connectors ? 'Adding connectors' : 'Updating parts');
    const res = await buildParts(base, cuts, connectors);
    this.freeParts();
    this.parts = res.parts;
    return { parts: res.parts.map(toPartData), warnings: res.warnings, connectorsPlaced: res.connectorsPlaced };
  }

  async layout(printer: PrinterProfile): Promise<PlacedData[]> {
    this.progress('Laying parts out on the plate');
    const placed = layoutOnPlates(this.parts, printer);
    return placed.map((p) => {
      const mesh = fromSolid(p.solid);
      p.solid.delete();
      return { id: p.id, plate: p.plate, mesh };
    });
  }

  /** Free everything (closing the model). */
  dispose() {
    this.freeParts();
    this.base?.delete();
    this.base = null;
  }

  private need(): Manifold {
    if (!this.base) throw new Error('Drop a model first.');
    return this.base;
  }

  private freeParts() {
    for (const p of this.parts) p.solid.delete();
    this.parts = [];
  }

  private async setBase(solid: Manifold, name: string, repairs: string[]): Promise<BaseData> {
    await getKernel();
    // Sit the model on the plate, centered.
    const b = solidBounds(solid);
    const centered = solid.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]);
    solid.delete();
    this.dispose();
    this.base = centered;
    this.fileName = name;
    this.repairs = repairs;
    const whole: BuiltPart = { id: 'p0', name: 'Part 1', kind: 'part', solid: centered.translate([0, 0, 0]), faces: [] };
    this.parts = [whole];
    const part = toPartData(whole);
    return { fileName: name, health: analyzeMesh(part.mesh), repairs, bounds: part.bounds, part };
  }
}

function toPartData(p: BuiltPart): PartData {
  return { id: p.id, name: p.name, kind: p.kind, faces: p.faces, mesh: fromSolid(p.solid), bounds: solidBounds(p.solid) };
}

/** Methods callable across the worker boundary. */
export type EngineMethod = 'load' | 'sample' | 'scale' | 'mirror' | 'suggest' | 'anchor' | 'build' | 'layout' | 'dispose';
