import { create } from 'zustand';
import type { Manifold } from 'manifold-3d';
import { toSolid, fromSolid, solidBounds, getKernel } from '../core/geometry';
import { loadModel } from '../core/loaders';
import { type TriMesh, type MeshHealth, analyzeMesh, type Vec3 } from '../core/mesh';
import { type PrinterProfile, DEFAULT_PRINTER, PRINTERS, fitsPrinterAnyOrientation } from '../core/printers';
import { type SplitPlan, suggestPlans, scorePlan, PRESETS } from '../core/smartcut';
import { type CutSpec, type CutFace, buildParts, newId, sectionAnchor, shiftCut, tiltCut } from '../core/pipeline';
import { type ConnectorSettings, DEFAULT_CONNECTOR } from '../core/connectors';
import { PaintTarget, DEFAULT_PALETTE } from '../core/paint';
import { layoutOnPlates } from '../core/orient';
import { export3mf } from '../core/export3mf';
import { sampleFigure } from '../core/samples';

export type Step = 'drop' | 'chop' | 'connect' | 'paint' | 'print';
export const STEPS: { id: Step; label: string }[] = [
  { id: 'drop', label: 'Drop' },
  { id: 'chop', label: 'Chop' },
  { id: 'connect', label: 'Connect' },
  { id: 'paint', label: 'Paint' },
  { id: 'print', label: 'Print' },
];
export type Mode = 'chop' | 'workshop';
export type PaintTool = 'part' | 'brush' | 'smart';

export interface PartView {
  id: string;
  name: string;
  kind: 'part' | 'pin';
  solid: Manifold;
  mesh: TriMesh;
  paint: PaintTarget;
  faces: CutFace[];
  size: Vec3;
  fits: boolean;
  /** Bumped whenever paint changes so the viewport re-uploads colors. */
  version: number;
}

export interface PlacedView {
  id: string;
  name: string;
  mesh: TriMesh;
  colors: Uint8Array;
  plate: number;
}

interface State {
  mode: Mode;
  step: Step;
  printer: PrinterProfile;
  busy: string | null;
  error: string | null;
  notice: string | null;
  fileName: string | null;
  base: Manifold | null;
  health: MeshHealth | null;
  repairs: string[];
  plans: SplitPlan[];
  selectedPlanId: string | null;
  cuts: CutSpec[];
  selectedCutId: string | null;
  connector: ConnectorSettings;
  connectorsApplied: boolean;
  parts: PartView[];
  warnings: string[];
  palette: string[];
  slotCount: number;
  activeSlot: number;
  paintTool: PaintTool;
  brushRadius: number;
  smartAngle: number;
  explode: number;
  selectedPartId: string | null;
  placed: PlacedView[];

  setMode(m: Mode): void;
  setStep(s: Step): void;
  setPrinter(id: string): void;
  loadFile(file: File): Promise<void>;
  loadSample(): Promise<void>;
  suggest(): Promise<void>;
  selectPlan(id: string): Promise<void>;
  selectCut(id: string | null): void;
  moveCut(id: string, offset: number): void;
  tiltCutBy(id: string, axis: Vec3, degrees: number): void;
  removeCut(id: string): void;
  addManualCut(normal: Vec3, offset: number): void;
  commitCuts(): Promise<void>;
  setConnector(patch: Partial<ConnectorSettings>): void;
  setCutConnector(id: string, patch: Partial<ConnectorSettings> | null): void;
  applyConnectors(): Promise<void>;
  setExplode(v: number): void;
  setPaint(patch: Partial<Pick<State, 'activeSlot' | 'paintTool' | 'brushRadius' | 'smartAngle' | 'slotCount'>>): void;
  setPaletteColor(i: number, c: string): void;
  paintAt(partId: string, tri: number, point: Vec3): void;
  fillPartsByIndex(): void;
  selectPart(id: string | null): void;
  scaleModel(factor: number): Promise<void>;
  mirrorModel(axis: 0 | 1 | 2): Promise<void>;
  layout(): void;
  exportProject(): Promise<void>;
  dismissNotice(): void;
}

const yieldFrame = () => new Promise((r) => setTimeout(r, 30));

function makePartView(p: { id: string; name: string; kind: 'part' | 'pin'; solid: Manifold; faces: CutFace[] }, printer: PrinterProfile, slot = 0): PartView {
  const mesh = fromSolid(p.solid);
  const b = solidBounds(p.solid);
  const size: Vec3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const paint = new PaintTarget(mesh);
  if (slot) paint.fillAll(slot);
  return { ...p, mesh, paint, size, fits: fitsPrinterAnyOrientation(size, printer), version: 0 };
}

let rebuildToken = 0;

export const useStore = create<State>((set, get) => {
  const run = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    set({ busy: label, error: null });
    await yieldFrame();
    try {
      return await fn();
    } catch (e) {
      console.error(e);
      set({ error: e instanceof Error ? e.message : String(e) });
      return undefined;
    } finally {
      set({ busy: null });
    }
  };

  /** Rebuild parts from base + cuts (connectors only when requested). */
  const rebuild = async (withConnectors: boolean) => {
    const { base, cuts, connector, printer } = get();
    if (!base) return;
    const token = ++rebuildToken;
    const res = await buildParts(base, cuts, withConnectors ? connector : null);
    if (token !== rebuildToken) return;
    const parts = res.parts.map((p) => makePartView(p, printer));
    set({ parts, warnings: res.warnings, connectorsApplied: withConnectors, placed: [] });
  };

  const setBase = async (solid: Manifold, name: string, repairs: string[]) => {
    // Sit the model on the plate, centered.
    const b = solidBounds(solid);
    const centered = solid.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]);
    const mesh = fromSolid(centered);
    set({
      base: centered, fileName: name, health: analyzeMesh(mesh), repairs,
      plans: [], selectedPlanId: null, cuts: [], selectedCutId: null, connectorsApplied: false,
      parts: [makePartView({ id: 'p0', name: 'Part 1', kind: 'part', solid: centered, faces: [] }, get().printer)],
      warnings: [], placed: [], selectedPartId: null, explode: 0,
    });
  };

  return {
    mode: 'chop',
    step: 'drop',
    printer: DEFAULT_PRINTER,
    busy: null,
    error: null,
    notice: null,
    fileName: null,
    base: null,
    health: null,
    repairs: [],
    plans: [],
    selectedPlanId: null,
    cuts: [],
    selectedCutId: null,
    connector: DEFAULT_CONNECTOR,
    connectorsApplied: false,
    parts: [],
    warnings: [],
    palette: DEFAULT_PALETTE.slice(0, 9),
    slotCount: 4,
    activeSlot: 1,
    paintTool: 'part',
    brushRadius: 6,
    smartAngle: 30,
    explode: 0,
    selectedPartId: null,
    placed: [],

    setMode: (mode) => set({ mode }),
    setStep: (step) => {
      const s = get();
      if (step !== 'drop' && !s.base) return;
      set({ step });
      if (step === 'chop' && s.base && !s.plans.length && !s.busy) void get().suggest();
      if (step === 'connect' && s.explode < 0.2) set({ explode: 0.35 });
      if (step === 'print') get().layout();
    },
    setPrinter: (id) => {
      const printer = PRINTERS.find((p) => p.id === id) ?? DEFAULT_PRINTER;
      set((s) => ({
        printer,
        slotCount: Math.min(Math.max(s.slotCount, 2), printer.maxColors),
        parts: s.parts.map((p) => ({ ...p, fits: fitsPrinterAnyOrientation(p.size, printer) })),
        plans: [],
        placed: [],
      }));
      if (get().step === 'chop' && get().base) void get().suggest();
    },
    loadFile: async (file) => {
      await run(`Reading ${file.name}`, async () => {
        const buf = await file.arrayBuffer();
        const mesh = await loadModel(file.name, buf);
        set({ busy: 'Checking and repairing the mesh' });
        await yieldFrame();
        const { solid, repaired } = await toSolid(mesh);
        await setBase(solid, file.name, repaired);
      });
      if (get().base) get().setStep('chop');
    },
    loadSample: async () => {
      await run('Building the sample figure', async () => {
        const fig = await sampleFigure(300);
        await setBase(fig, 'Sample figure (300 mm)', []);
      });
      if (get().base) get().setStep('chop');
    },
    suggest: async () => {
      const { base, printer } = get();
      if (!base) return;
      await run('Finding the best places to cut', async () => {
        const plans = await suggestPlans(base, printer);
        set({ plans });
        if (plans.length) {
          const best = [...plans].sort((a, b) => b.scores.overall - a.scores.overall)[0];
          set({ selectedPlanId: best.id, cuts: best.cuts, selectedCutId: null });
          await rebuild(false);
          set({ explode: 0.25 });
        }
      });
    },
    selectPlan: async (id) => {
      const plan = get().plans.find((p) => p.id === id);
      if (!plan) return;
      set({ selectedPlanId: id, cuts: plan.cuts, selectedCutId: null });
      await run('Previewing parts', () => rebuild(false));
    },
    selectCut: (id) => set({ selectedCutId: id }),
    moveCut: (id, offset) => {
      set((s) => ({ cuts: s.cuts.map((c) => (c.id === id ? shiftCut(c, offset) : c)), selectedPlanId: null }));
    },
    tiltCutBy: (id, axis, degrees) => {
      set((s) => ({ cuts: s.cuts.map((c) => (c.id === id ? tiltCut(c, axis, degrees) : c)), selectedPlanId: null }));
    },
    removeCut: (id) => {
      set((s) => ({ cuts: s.cuts.filter((c) => c.id !== id), selectedCutId: null, selectedPlanId: null }));
      void get().commitCuts();
    },
    addManualCut: (normal, offset) => {
      const { base } = get();
      if (!base) return;
      const plane = { normal, offset };
      const anchor = sectionAnchor(base, plane);
      if (!anchor) { set({ error: 'That plane does not cross the model.' }); return; }
      const cut: CutSpec = { id: newId('cut'), plane, anchor, neck: 0, reasons: ['Your cut'] };
      set((s) => ({ cuts: [...s.cuts, cut], selectedCutId: cut.id, selectedPlanId: null }));
      void get().commitCuts();
    },
    commitCuts: async () => {
      await run('Updating parts', () => rebuild(false));
    },
    setConnector: (patch) => set((s) => ({ connector: { ...s.connector, ...patch }, connectorsApplied: false })),
    setCutConnector: (id, patch) => set((s) => ({
      cuts: s.cuts.map((c) => (c.id === id ? { ...c, connector: patch ? { ...(c.connector ?? s.connector), ...patch } : undefined } : c)),
      connectorsApplied: false,
    })),
    applyConnectors: async () => {
      await run('Adding connectors', () => rebuild(true));
    },
    setExplode: (explode) => set({ explode }),
    setPaint: (patch) => set(patch),
    setPaletteColor: (i, c) => set((s) => ({ palette: s.palette.map((p, k) => (k === i ? c : p)) })),
    paintAt: (partId, tri, point) => {
      const s = get();
      const part = s.parts.find((p) => p.id === partId);
      if (!part) return;
      let changed = 0;
      if (s.paintTool === 'part') { part.paint.fillAll(s.activeSlot); changed = 1; }
      else if (s.paintTool === 'brush') changed = part.paint.brush(point, s.brushRadius, s.activeSlot);
      else changed = part.paint.smartFill(tri, s.activeSlot, s.smartAngle);
      if (changed) set({ parts: s.parts.map((p) => (p.id === partId ? { ...p, version: p.version + 1 } : p)), placed: [] });
    },
    fillPartsByIndex: () => {
      const s = get();
      let i = 0;
      const parts = s.parts.map((p) => {
        if (p.kind === 'part') { p.paint.fillAll(i % s.slotCount); i++; }
        return { ...p, version: p.version + 1 };
      });
      set({ parts, placed: [] });
    },
    selectPart: (id) => set({ selectedPartId: id }),
    scaleModel: async (factor) => {
      const { base, fileName } = get();
      if (!base) return;
      await run('Scaling', async () => setBase(base.scale([factor, factor, factor]), fileName ?? 'Model', []));
      if (get().step === 'chop') await get().suggest();
    },
    mirrorModel: async (axis) => {
      const { base, fileName } = get();
      if (!base) return;
      const n: Vec3 = [0, 0, 0];
      n[axis] = 1;
      await run('Mirroring', async () => setBase(base.mirror(n), fileName ?? 'Model', get().repairs));
    },
    layout: () => {
      const { parts, printer } = get();
      if (!parts.length) return;
      const placed = layoutOnPlates(parts, printer);
      const byId = new Map(parts.map((p) => [p.id, p]));
      set({
        placed: placed.map((pp) => {
          const part = byId.get(pp.id)!;
          // Orientation/translation is rigid, so triangle order (and paint) is kept.
          const mesh = fromSolid(pp.solid);
          const colors = mesh.indices.length === part.mesh.indices.length ? part.paint.colors : new Uint8Array(mesh.indices.length / 3);
          return { id: pp.id, name: part.name, mesh, colors, plate: pp.plate };
        }),
      });
    },
    exportProject: async () => {
      await run('Writing 3MF', async () => {
        if (!get().placed.length) get().layout();
        const { placed, palette, slotCount, fileName } = get();
        const bytes = await export3mf(
          placed.map((p) => ({ name: p.name, mesh: p.mesh, colors: p.colors })),
          palette.slice(0, slotCount),
        );
        const blob = new Blob([bytes as BlobPart], { type: 'model/3mf' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const stem = (fileName ?? 'model').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
        a.download = `${stem}_model-garage.3mf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        const plates = Math.max(...placed.map((p) => p.plate)) + 1;
        set({ notice: `Saved ${a.download}. ${placed.length} pieces${plates > 1 ? ` laid out for ${plates} plates` : ''}. Open it in ${get().printer.slicer}.` });
      });
    },
    dismissNotice: () => set({ notice: null, error: null }),
  };
});

// Warm up the geometry kernel early so the first drop feels instant.
void getKernel();
export { PRESETS, scorePlan };
