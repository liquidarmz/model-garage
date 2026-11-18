/**
 * Color plans for paint-from-picture: which filament each picture region
 * gets. Claude makes the plan when the page can ask it (it can tell shading
 * from paint, and skip logos or backgrounds); otherwise a quick local plan
 * groups the regions by color.
 */
import { type RGB, type RGBImage, kmeansColors, nearest, hexToRgb, rgbToHex } from '../core/imagePaint';
import type { PaintPlan, Segmentation } from '../core/segment';

type SampleJson = (input: string, opts?: { images?: Blob[]; signal?: AbortSignal; modelTier?: string; cache?: boolean }) => Promise<unknown>;
interface SampleFn { json: SampleJson; limits(): Promise<{ images?: { maxCount: number } }> }

let samplerPromise: Promise<SampleFn | null> | null = null;

/** Claude's sample function when this page can send it pictures, else null. */
export function getSampler(): Promise<SampleFn | null> {
  if (!samplerPromise) {
    samplerPromise = (async () => {
      const c = (window as unknown as { claude?: { use(n: string): Promise<unknown> } }).claude;
      if (!c?.use) return null;
      try {
        const s = (await c.use('sample')) as SampleFn | null;
        if (!s) return null;
        const lim = await s.limits().catch(() => null);
        return lim?.images ? s : null;
      } catch {
        return null;
      }
    })();
  }
  return samplerPromise;
}

/** Plan by color alone: group regions with k-means, or snap them to the given filaments. */
export function localPlan(seg: Segmentation, maxColors: number, filaments: string[] | null): PaintPlan {
  if (filaments) {
    const pal = filaments.map(hexToRgb);
    return {
      colors: filaments.map((hex, i) => ({ name: `Filament ${i + 1}`, hex })),
      assign: seg.regions.map((r) => nearest(r.color, pal)),
      source: 'local',
    };
  }
  // Weight each region by its size.
  const samples: RGB[] = [];
  const total = seg.regions.reduce((n, r) => n + r.area, 0) || 1;
  for (const r of seg.regions) for (let i = 0, n = Math.max(1, Math.round((r.area / total) * 2000)); i < n; i++) samples.push(r.color);
  const found = kmeansColors(samples, maxColors);
  return {
    colors: found.map((c, i) => ({ name: `Color ${i + 1}`, hex: rgbToHex(c) })),
    assign: seg.regions.map((r) => nearest(r.color, found)),
    source: 'local',
  };
}

function toCanvas(img: RGBImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the picture.'))), 'image/png'));
}

export function imageToDataUrl(img: RGBImage): string {
  return toCanvas(img).toDataURL('image/png');
}

/** The picture with each region outlined and numbered (from 1), for Claude to read. */
export function numberedPicture(img: RGBImage, seg: Segmentation): HTMLCanvasElement {
  const k = 900 / Math.max(img.width, img.height);
  const W = Math.round(img.width * k), H = Math.round(img.height * k);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(toCanvas(img), 0, 0, W, H);
  // Outlines, drawn at segmentation resolution and scaled up.
  const L = seg.labels, sw = seg.width, sh = seg.height;
  const edges = new ImageData(sw, sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = y * sw + x, l = L[i];
    if ((x < sw - 1 && L[i + 1] !== l) || (y < sh - 1 && L[i + sw] !== l)) {
      edges.data[i * 4] = 255; edges.data[i * 4 + 1] = 0; edges.data[i * 4 + 2] = 255; edges.data[i * 4 + 3] = 255;
    }
  }
  const e = document.createElement('canvas');
  e.width = sw; e.height = sh;
  e.getContext('2d')!.putImageData(edges, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(e, 0, 0, W, H);
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 4;
  for (const r of seg.regions) {
    const x = ((r.anchor[0] + 0.5) / sw) * W, y = ((r.anchor[1] + 0.5) / sh) * H;
    ctx.strokeStyle = '#000';
    ctx.strokeText(String(r.id + 1), x, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(r.id + 1), x, y);
  }
  return c;
}

interface ClaudeReply {
  colors?: { name?: unknown; hex?: unknown; filament?: unknown }[];
  regions?: Record<string, unknown>;
  notes?: unknown;
}

/** Ask Claude to read the picture and plan the colors. */
export async function claudePlan(
  sample: SampleFn, img: RGBImage, seg: Segmentation,
  o: { maxColors: number; filaments: string[] | null; signal?: AbortSignal },
): Promise<PaintPlan> {
  const total = seg.regions.reduce((n, r) => n + r.area, 0) || 1;
  const list = seg.regions.map((r) => `${r.id + 1}: ${rgbToHex(r.color)}, ${((r.area / total) * 100).toFixed(1)}%`).join('\n');
  const fil = o.filaments;
  const prompt = [
    'You are helping paint a multi-color 3D print so it matches a reference picture.',
    'Image 1 is the reference picture. Image 2 is the same picture split into numbered regions (magenta outlines, white numbers).',
    'Each region will be printed in one filament color.',
    '',
    'Regions (number: average color as photographed, share of the subject):',
    list,
    '',
    'Work out the real paint or material colors of the subject, ignoring lighting: highlights, shading, reflections and shadows on the same material are ONE color.',
    'Give each color a short name for the part it paints, like "Skin", "Hair", "Laces" or "Sole".',
    'For every region give the index of its color, or -1 if it is not part of the subject (background, floor, cast shadows, text, logos, watermarks, frames).',
    fil
      ? `Use only these filaments (index: color): ${fil.map((h, i) => `${i}: ${h}`).join(', ')}. In "colors" list the filaments you use, with "filament" set to its index and "hex" its color.`
      : `Use at most ${o.maxColors} colors. Give each color's true hex as it would look in even, neutral light.`,
    '',
    'Reply with only JSON in this shape:',
    fil
      ? '{"colors":[{"name":"Hair","filament":2,"hex":"#1b1b1b"}],"regions":{"1":0,"2":-1},"notes":"One short sentence on anything you were unsure of."}'
      : '{"colors":[{"name":"Hair","hex":"#1b1b1b"}],"regions":{"1":0,"2":-1},"notes":"One short sentence on anything you were unsure of."}',
    '"regions" maps region numbers to an index into "colors".',
  ].join('\n');
  const [orig, numbered] = await Promise.all([toBlob(toCanvas(img)), toBlob(numberedPicture(img, seg))]);
  const reply = (await sample.json(prompt, { images: [orig, numbered], signal: o.signal, cache: false })) as ClaudeReply;
  return readReply(reply, seg, o.maxColors, fil);
}

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim());

/** Turn Claude's JSON into a plan, filling any gaps by color. */
export function readReply(reply: ClaudeReply, seg: Segmentation, maxColors: number, filaments: string[] | null): PaintPlan {
  const raw = Array.isArray(reply?.colors) ? reply.colors : [];
  const notes = typeof reply?.notes === 'string' ? reply.notes : undefined;
  let colors: { name: string; hex: string }[];
  let remap: number[]; // Claude's color index -> plan color index
  if (filaments) {
    colors = filaments.map((hex, i) => ({ name: `Filament ${i + 1}`, hex }));
    remap = raw.map((c) => {
      const f = Number(c?.filament);
      if (Number.isInteger(f) && f >= 0 && f < filaments.length) {
        if (typeof c.name === 'string' && c.name.trim()) colors[f].name = colors[f].name.startsWith('Filament') ? c.name.trim() : `${colors[f].name}, ${c.name.trim()}`;
        return f;
      }
      return isHex(c?.hex) ? nearest(hexToRgb(c.hex), filaments.map(hexToRgb)) : -1;
    });
  } else {
    const good = raw.map((c, i) => ({ c, i })).filter(({ c }) => isHex(c?.hex)).slice(0, maxColors);
    colors = good.map(({ c }, k) => ({ name: typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 40) : `Color ${k + 1}`, hex: (c.hex as string).trim().toLowerCase() }));
    remap = raw.map((_, i) => good.findIndex((g) => g.i === i));
  }
  if (!colors.length) throw new Error('Claude did not suggest any colors. Try again, or use a quick plan.');
  const pal = colors.map((c) => hexToRgb(c.hex));
  const regions = reply?.regions && typeof reply.regions === 'object' ? reply.regions : {};
  const assign = seg.regions.map((r) => {
    const v = Number((regions as Record<string, unknown>)[String(r.id + 1)]);
    if (v === -1) return -1;
    if (Number.isInteger(v) && v >= 0 && v < remap.length && remap[v] >= 0) return remap[v];
    return nearest(r.color, pal); // missing or invalid: closest color
  });
  return { colors, assign, notes, source: 'claude' };
}
