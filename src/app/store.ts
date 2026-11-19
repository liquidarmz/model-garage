import { create } from 'zustand';
import { type TriMesh, type MeshHealth, type Vec3, translateMesh } from '../core/mesh';
import { type PrinterProfile, DEFAULT_PRINTER, PRINTERS, fitsPrinterAnyOrientation, plateOrigin } from '../core/printers';
import type { SplitPlan } from '../core/smartcut';
import { type CutSpec, type CutFace, newId, shiftCut, tiltCut } from '../core/pipeline';
import { type ConnectorSettings, DEFAULT_CONNECTOR } from '../core/connectors';
import { PaintTarget, DEFAULT_PALETTE } from '../core/paint';
import { export3mf } from '../core/export3mf';
import type { BaseData, Bounds, PartData } from '../core/engine';
import { createEngine } from './engineClient';
import * as THREE from 'three';
import { viewRegistry } from './viewRegistry';
import { type RGB, type RGBImage, projectPicture, makeProjector, kmeansColors, nearest, hexToRgb, rgbToHex } from '../core/imagePaint';
import { saveFile } from './saveFile';
import { refineAndPaint } from '../core/refine';

/** Most extra triangles a picture may add across the model. */
const DETAIL_BUDGET = 1_500_000;
import { type PaintPlan, type Segmentation, segmentPicture, planImage } from '../core/segment';
import { getSampler, localPlan, claudePlan, imageToDataUrl } from './colorPlan';

const engine = createEngine();

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
  bounds: Bounds;
  mesh: TriMesh;
  paint: PaintTarget;
  faces: CutFace[];
  size: Vec3;
  fits: boolean;
  /** Bumped whenever paint changes so the viewport re-uploads colors. */
  version: number;
  /** The part's mesh as the geometry engine has it, when painting split triangles for detail. */
  sourceMesh?: TriMesh;
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
  /** The loaded model (geometry itself lives in the worker). */
  base: { bounds: Bounds } | null;
  health: MeshHealth | null;
  repairs: string[];
  /** Objects in the loaded file (3MF projects can hold several). */
  items: { name: string; triangles: number }[];
  item: number;
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
  /** Reference picture for paint-from-picture (object URL + pixels). */
  picture: { url: string; name: string; image: RGBImage } | null;
  pictureOpacity: number;
  pictureScale: number;
  pictureOffset: [number, number];
  pictureColors: 'picture' | 'mine';
  picturePaintBack: boolean;
  /** Picture split into regions (made when a plan is first asked for). */
  pictureSeg: Segmentation | null;
  /** Color plan waiting for approval, and a flat-color preview of it. */
  picturePlan: PaintPlan | null;
  planPreview: string | null;
  showPlan: boolean;
  planning: boolean;

  setMode(m: Mode): void;
  setStep(s: Step): void;
  setPrinter(id: string): void;
  loadFile(file: File): Promise<void>;
  loadSample(): Promise<void>;
  pickItem(index: number): Promise<void>;
  suggest(): Promise<void>;
  selectPlan(id: string): Promise<void>;
  selectCut(id: string | null): void;
  moveCut(id: string, offset: number): void;
  tiltCutBy(id: string, axis: Vec3, degrees: number): void;
  removeCut(id: string): void;
  addManualCut(normal: Vec3, offset: number): Promise<void>;
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
  layout(): Promise<void>;
  /** Download a 3MF: every plate, or only `plate` (0-based) moved onto a single bed. */
  exportProject(plate?: number): Promise<void>;
  dismissNotice(): void;
  setPicture(file: File | null): Promise<void>;
  setPictureOptions(patch: Partial<Pick<State, 'pictureOpacity' | 'pictureScale' | 'pictureOffset' | 'pictureColors' | 'picturePaintBack'>>): void;
  applyPicture(): Promise<void>;
  makePlan(withClaude: boolean): Promise<void>;
  cancelPlan(): void;
  setPlanColor(i: number, patch: { name?: string; hex?: string }): void;
  clearPlan(): void;
  cleanupPaint(): void;
}

/** Decode a picture into pixels, at most 1024 px on its long side. */
async function readPicture(url: string): Promise<RGBImage> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

/** The rotation + move taking mesh `a` onto mesh `b` (same vertices, rigidly moved), or null. */
function rigidBetween(a: TriMesh, b: TriMesh): THREE.Matrix4 | null {
  if (a.positions.length !== b.positions.length || a.positions.length < 9) return null;
  const P = (m: TriMesh, i: number) => new THREE.Vector3(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]);
  const n = a.positions.length / 3;
  // Three well-spread vertices: the first, the farthest from it, and the farthest from that line.
  const a0 = P(a, 0);
  let i1 = 0, d1 = 0;
  for (let i = 0; i < n; i++) { const d = P(a, i).distanceToSquared(a0); if (d > d1) { d1 = d; i1 = i; } }
  const axis = P(a, i1).sub(a0).normalize();
  let i2 = 0, d2 = 0;
  for (let i = 0; i < n; i++) { const v = P(a, i).sub(a0); const d = v.sub(axis.clone().multiplyScalar(v.dot(axis))).lengthSq(); if (d > d2) { d2 = d; i2 = i; } }
  if (d2 < 1e-8) return null;
  const frame = (m: TriMesh) => {
    const o = P(m, 0), x = P(m, i1).sub(o).normalize();
    const z = new THREE.Vector3().crossVectors(x, P(m, i2).sub(o)).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    return new THREE.Matrix4().makeBasis(x, y, z).setPosition(o);
  };
  const T = frame(b).multiply(frame(a).invert());
  // Check a few vertices actually line up.
  for (let k = 0; k < 8; k++) {
    const i = Math.floor((k * (n - 1)) / 7);
    if (P(a, i).applyMatrix4(T).distanceTo(P(b, i)) > 1e-2) return null;
  }
  return T;
}

function applyRigid(m: TriMesh, T: THREE.Matrix4 | null): TriMesh | null {
  if (!T) return null;
  const e = T.elements, p = m.positions, out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  return { positions: out, indices: m.indices };
}

const yieldFrame = () => new Promise((r) => setTimeout(r, 30));

function makePartView(p: PartData, printer: PrinterProfile, slot = 0): PartView {
  const b = p.bounds;
  const size: Vec3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const paint = new PaintTarget(p.mesh);
  if (slot) paint.fillAll(slot);
  return { ...p, paint, size, fits: fitsPrinterAnyOrientation(size, printer), version: 0 };
}
export type { CutFace };

let rebuildToken = 0;
let planAbort: AbortController | null = null;

export const useStore = create<State>((set, get) => {
  engine.onProgress = (label) => { if (get().busy) set({ busy: label }); };
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
    const res = await engine.build(cuts, withConnectors ? connector : null);
    if (token !== rebuildToken) return;
    const parts = res.parts.map((p) => makePartView(p, printer));
    set({ parts, warnings: res.warnings, connectorsApplied: withConnectors, placed: [] });
  };

  const setBase = (d: BaseData) => {
    set({
      base: { bounds: d.bounds }, fileName: d.fileName, health: d.health, repairs: d.repairs, items: d.items, item: d.item,
      plans: [], selectedPlanId: null, cuts: [], selectedCutId: null, connectorsApplied: false,
      parts: [makePartView(d.part, get().printer)],
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
    items: [],
    item: 0,
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
    picture: null,
    pictureOpacity: 0.5,
    pictureScale: 1,
    pictureOffset: [0, 0],
    pictureColors: 'picture',
    picturePaintBack: false,
    pictureSeg: null,
    picturePlan: null,
    planPreview: null,
    showPlan: true,
    planning: false,

    setMode: (mode) => set({ mode }),
    setStep: (step) => {
      const s = get();
      if (step !== 'drop' && !s.base) return;
      set({ step });
      if (step === 'chop' && s.base && !s.plans.length && !s.busy) void get().suggest();
      if (step === 'connect' && s.explode < 0.2) set({ explode: 0.35 });
      if (step === 'print') void get().layout();
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
        setBase(await engine.load(file.name, buf));
      });
      // With several objects in the file, stay here so the user can pick one.
      if (get().base && get().items.length <= 1) get().setStep('chop');
    },
    pickItem: async (index) => {
      await run('Loading that object', async () => setBase(await engine.pickItem(index)));
    },
    loadSample: async () => {
      await run('Building the sample figure', async () => {
        setBase(await engine.sample(300));
      });
      if (get().base) get().setStep('chop');
    },
    suggest: async () => {
      const { base, printer } = get();
      if (!base) return;
      await run('Finding the best places to cut', async () => {
        const plans = await engine.suggest(printer);
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
    addManualCut: async (normal, offset) => {
      const { base } = get();
      if (!base) return;
      const plane = { normal, offset };
      const anchor = await engine.anchor(plane);
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
      if (!get().base) return;
      await run('Scaling', async () => setBase(await engine.scale(factor)));
      if (get().step === 'chop') await get().suggest();
    },
    mirrorModel: async (axis) => {
      if (!get().base) return;
      await run('Mirroring', async () => setBase(await engine.mirror(axis)));
    },
    layout: async () => {
      const { parts, printer } = get();
      if (!parts.length) return;
      const placed = await engine.layout(printer);
      const byId = new Map(get().parts.map((p) => [p.id, p]));
      set({
        placed: placed.flatMap((pp) => {
          const part = byId.get(pp.id);
          if (!part) return [];
          // Orientation/translation is rigid, so triangle order (and paint) is kept.
          const src = part.sourceMesh ?? part.mesh;
          if (pp.mesh.indices.length !== src.indices.length) return [{ id: pp.id, name: part.name, mesh: pp.mesh, colors: new Uint8Array(pp.mesh.indices.length / 3), plate: pp.plate }];
          if (!part.sourceMesh) return [{ id: pp.id, name: part.name, mesh: pp.mesh, colors: part.paint.colors, plate: pp.plate }];
          // Detail was added: move the detailed mesh the same way the engine moved the original.
          const moved = applyRigid(part.mesh, rigidBetween(src, pp.mesh));
          return [{ id: pp.id, name: part.name, mesh: moved ?? pp.mesh, colors: moved ? part.paint.colors : new Uint8Array(pp.mesh.indices.length / 3), plate: pp.plate }];
        }),
      });
    },
    exportProject: async (plate) => {
      await run('Writing 3MF', async () => {
        if (!get().placed.length) await get().layout();
        const { palette, slotCount, fileName, printer } = get();
        const all = get().placed;
        const plates = Math.max(...all.map((p) => p.plate)) + 1;
        let placed = all;
        if (plate !== undefined) {
          const [ox, oy] = plateOrigin(plate, plates, printer);
          placed = all.filter((p) => p.plate === plate).map((p) => ({ ...p, mesh: translateMesh(p.mesh, [-ox, -oy, 0]) }));
        }
        const bytes = await export3mf(
          placed.map((p) => ({ name: p.name, mesh: p.mesh, colors: p.colors })),
          palette.slice(0, slotCount),
        );
        const stem = (fileName ?? 'model').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
        const saved = await saveFile(`${stem}_model-garage${plate !== undefined ? `_plate${plate + 1}` : ''}.3mf`, bytes);
        const tip = plate === undefined && plates > 1 ? ` ${printer.slicer} opens all ${plates} plates' parts on one bed; download plates one at a time to keep them separate.` : '';
        set({ notice: `Saved ${saved} with ${placed.length} pieces. Open it in ${printer.slicer}.${tip}` });
      });
    },
    dismissNotice: () => set({ notice: null, error: null }),
    setPicture: async (file) => {
      const old = get().picture;
      if (old) URL.revokeObjectURL(old.url);
      planAbort?.abort();
      set({ pictureSeg: null, picturePlan: null, planPreview: null, planning: false });
      if (!file) { set({ picture: null }); return; }
      const url = URL.createObjectURL(file);
      try {
        const image = await readPicture(url);
        set({ picture: { url, name: file.name, image }, pictureScale: 1, pictureOffset: [0, 0] });
      } catch {
        URL.revokeObjectURL(url);
        set({ error: `Could not read ${file.name} as a picture.` });
      }
    },
    setPictureOptions: (patch) => {
      // A plan is made for one color mode; switching modes starts over.
      if (patch.pictureColors && patch.pictureColors !== get().pictureColors) set({ picturePlan: null, planPreview: null });
      set(patch);
    },
    makePlan: async (withClaude) => {
      const s = get();
      if (!s.picture || s.planning) return;
      planAbort?.abort();
      const ctl = new AbortController();
      planAbort = ctl;
      set({ planning: true, error: null, notice: null });
      await yieldFrame();
      try {
        const seg = s.pictureSeg ?? segmentPicture(s.picture.image);
        if (!seg.regions.length) throw new Error('Could not find the subject in this picture.');
        set({ pictureSeg: seg });
        const filaments = s.pictureColors === 'mine' ? s.palette.slice(0, s.slotCount) : null;
        const maxColors = s.pictureColors === 'mine' ? s.slotCount : s.printer.maxColors;
        const sample = withClaude ? await getSampler() : null;
        if (withClaude && !sample) throw new Error('Claude is not available on this page. Use a quick plan instead.');
        const plan = sample
          ? await claudePlan(sample, s.picture.image, seg, { maxColors, filaments, signal: ctl.signal })
          : localPlan(seg, Math.min(maxColors, Math.max(s.slotCount, 2)), filaments);
        if (ctl.signal.aborted || get().picture !== s.picture) return;
        set({ picturePlan: plan, planPreview: imageToDataUrl(planImage(seg, plan, hexToRgb)), showPlan: true });
      } catch (e) {
        if (ctl.signal.aborted) return;
        const code = (e as { code?: string })?.code;
        const msg = code === 'not_granted' ? 'Claude was not allowed to look at the picture. Use a quick plan instead.'
          : code === 'rate_limited' ? 'Claude is busy right now. Try again in a minute, or use a quick plan.'
          : code === 'invalid_json' ? 'Claude\'s answer could not be read. Try again.'
          : code ? `Claude could not make a plan (${code}). Try again, or use a quick plan.`
          : e instanceof Error ? e.message : String(e);
        set({ error: msg });
      } finally {
        if (planAbort === ctl) { planAbort = null; set({ planning: false }); }
      }
    },
    cancelPlan: () => { planAbort?.abort(); planAbort = null; set({ planning: false }); },
    setPlanColor: (i, patch) => {
      const { picturePlan: plan, pictureSeg: seg } = get();
      if (!plan || !seg) return;
      const next = { ...plan, colors: plan.colors.map((c, k) => (k === i ? { ...c, ...patch } : c)) };
      set({ picturePlan: next, planPreview: patch.hex ? imageToDataUrl(planImage(seg, next, hexToRgb)) : get().planPreview });
    },
    clearPlan: () => set({ picturePlan: null, planPreview: null }),
    applyPicture: async () => {
      const s = get();
      const cam = viewRegistry.camera;
      if (!s.picture || !cam) return;
      const plan = s.picturePlan, seg = s.pictureSeg;
      await run('Painting from the picture', async () => {
        cam.updateMatrixWorld();
        const viewProj = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        const parts = s.parts.filter((p) => viewRegistry.meshes.has(p.id));
        const projParts = parts.map((p) => {
          const obj = viewRegistry.meshes.get(p.id)!;
          obj.updateMatrixWorld();
          return { positions: p.mesh.positions, indices: p.mesh.indices, matrixWorld: obj.matrixWorld.elements };
        });
        const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
        const view = {
          viewProj: viewProj.elements, cameraPos: [camPos.x, camPos.y, camPos.z] as [number, number, number],
          width: viewRegistry.size.width, height: viewRegistry.size.height,
        };
        const source = plan ? planImage(seg!, plan, hexToRgb) : s.picture!.image;
        const popts = { paintBack: s.picturePaintBack, scale: s.pictureScale, offsetX: s.pictureOffset[0], offsetY: s.pictureOffset[1], backdrop: !plan };
        const proj = makeProjector(projParts, view, source, popts);
        let palette = s.palette;
        let slotCount = s.slotCount;
        if (plan && s.pictureColors === 'picture') {
          // The plan's colors become the filament slots.
          slotCount = Math.min(s.printer.maxColors, Math.max(2, plan.colors.length));
          palette = s.palette.map((c, i) => plan.colors[i]?.hex ?? c);
        } else if (!plan) {
          const samples = projectPicture(projParts, view, source, popts).flat().filter((c): c is RGB => !!c);
          if (!samples.length) throw new Error('The picture does not cover the model. Turn the model so it lines up with the picture, then try again.');
          if (s.pictureColors === 'picture') {
            const found = kmeansColors(samples, s.slotCount).map(rgbToHex);
            palette = s.palette.map((c, i) => found[i] ?? c);
          }
        }
        const pal = palette.slice(0, slotCount).map(hexToRgb);
        const slotOf = (c: RGB) => nearest(c, pal);
        // Surfaces the picture can't see keep their look: move them to the closest new color.
        const oldPal = s.palette.slice(0, s.slotCount).map(hexToRgb);
        const keep = oldPal.map((c) => nearest(c, pal));
        // Extra triangles to spend on detail, shared by size.
        const totalTris = parts.reduce((n, p) => n + p.paint.triCount, 0) || 1;
        let painted = 0, added = 0;
        const updated = new Map<string, PartView>();
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          set({ busy: `Painting fine detail${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ''}` });
          await yieldFrame();
          const start = palette !== s.palette ? Uint8Array.from(p.paint.colors, (c) => keep[c] ?? 0) : p.paint.colors;
          const extra = Math.max(150_000, Math.round((DETAIL_BUDGET * p.paint.triCount) / totalTris));
          const r = refineAndPaint(p.mesh, start, projParts[i].matrixWorld, proj, slotOf, { minEdge: 0.2, maxTris: p.paint.triCount + extra });
          const paint = new PaintTarget(r.mesh, r.colors);
          // A photo (no plan) is noisy: tidy what it painted.
          if (!plan) { paint.removeSpecks(4, r.painted); paint.smooth(1, r.painted); }
          painted += r.painted.reduce((n, v) => n + v, 0);
          added += r.added;
          updated.set(p.id, { ...p, mesh: r.mesh, paint, sourceMesh: p.sourceMesh ?? p.mesh, version: p.version + 1 });
        }
        if (!painted) throw new Error('The picture does not cover the model. Turn the model so it lines up with the picture, then try again.');
        set({
          palette,
          slotCount,
          showPlan: false,
          parts: get().parts.map((p) => updated.get(p.id) ?? { ...p, version: p.version + 1 }),
          placed: [],
          notice: `Painted ${painted.toLocaleString()} surfaces from ${s.picture!.name}${added ? `, adding ${added.toLocaleString()} small triangles for detail` : ''}. Turn the model and apply again to cover other sides.`,
        });
      });
    },
    cleanupPaint: () => {
      const parts = get().parts;
      let changed = 0;
      for (const p of parts) {
        changed += p.paint.removeSpecks(Math.max(6, Math.round(p.paint.triCount / 2000)));
        changed += p.paint.smooth(2);
      }
      set({ parts: parts.map((p) => ({ ...p, version: p.version + 1 })), placed: [], notice: changed ? `Cleaned up ${changed.toLocaleString()} surfaces.` : 'Nothing to clean up.' });
    },
  };
});


// Handle for automated browser tests.
(window as unknown as { __modelGarage?: unknown }).__modelGarage = useStore;
