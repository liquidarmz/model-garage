import JSZip from 'jszip';
import { type TriMesh, weld, transformMesh } from './mesh';

export type ModelFormat = 'stl' | 'obj' | 'ply' | '3mf';

export function formatFromName(name: string): ModelFormat | null {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'stl' || ext === 'obj' || ext === 'ply' || ext === '3mf') return ext;
  return null;
}

export async function loadModel(name: string, data: ArrayBuffer): Promise<TriMesh> {
  const fmt = formatFromName(name);
  switch (fmt) {
    case 'stl': return parseSTL(data);
    case 'obj': return parseOBJ(new TextDecoder().decode(data));
    case 'ply': return parsePLY(data);
    case '3mf': return parse3MF(data);
    default: throw new Error(`Unsupported file type: ${name}. Use STL, OBJ, PLY or 3MF.`);
  }
}

// ---------- STL ----------

export function parseSTL(data: ArrayBuffer): TriMesh {
  const view = new DataView(data);
  if (data.byteLength >= 84) {
    const n = view.getUint32(80, true);
    if (84 + n * 50 === data.byteLength) return parseBinarySTL(view, n);
  }
  const text = new TextDecoder().decode(data);
  if (/^\s*solid/i.test(text) && /facet/i.test(text)) return parseAsciiSTL(text);
  // Some binary files start with "solid" in the header; try binary anyway.
  if (data.byteLength >= 84) return parseBinarySTL(view, Math.floor((data.byteLength - 84) / 50));
  throw new Error('Could not read STL file');
}

function parseBinarySTL(view: DataView, n: number): TriMesh {
  const pos = new Float32Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12; // skip normal
    for (let k = 0; k < 9; k++) {
      pos[i * 9 + k] = view.getFloat32(o, true);
      o += 4;
    }
    o += 2;
  }
  return weld(pos);
}

function parseAsciiSTL(text: string): TriMesh {
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  const pos: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) pos.push(+m[1], +m[2], +m[3]);
  return weld(pos);
}

// ---------- OBJ ----------

export function parseOBJ(text: string): TriMesh {
  const verts: number[] = [];
  const idx: number[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.split(/\s+/);
      verts.push(+x, +y, +z);
    } else if (line.startsWith('f ')) {
      const parts = line.split(/\s+/).slice(1).map((s) => {
        const i = parseInt(s.split('/')[0], 10);
        return i < 0 ? verts.length / 3 + i : i - 1;
      });
      for (let k = 1; k + 1 < parts.length; k++) idx.push(parts[0], parts[k], parts[k + 1]);
    }
  }
  return weld(verts, idx);
}

// ---------- PLY ----------

export function parsePLY(data: ArrayBuffer): TriMesh {
  const bytes = new Uint8Array(data);
  const headerEnd = findHeaderEnd(bytes);
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd));
  const lines = header.split(/\r?\n/);
  const format = lines.find((l) => l.startsWith('format'))?.split(/\s+/)[1] ?? 'ascii';
  type Elem = { name: string; count: number; props: { name: string; type: string; list?: [string, string] }[] };
  const elems: Elem[] = [];
  for (const l of lines) {
    const t = l.trim().split(/\s+/);
    if (t[0] === 'element') elems.push({ name: t[1], count: +t[2], props: [] });
    else if (t[0] === 'property' && elems.length) {
      const e = elems[elems.length - 1];
      if (t[1] === 'list') e.props.push({ name: t[4], type: 'list', list: [t[2], t[3]] });
      else e.props.push({ name: t[2], type: t[1] });
    }
  }
  const verts: number[] = [];
  const idx: number[] = [];
  if (format === 'ascii') {
    const body = new TextDecoder().decode(bytes.subarray(headerEnd)).trim().split(/\s+/).map(Number);
    let o = 0;
    for (const e of elems) {
      for (let i = 0; i < e.count; i++) {
        const vals: Record<string, number | number[]> = {};
        for (const p of e.props) {
          if (p.list) {
            const n = body[o++];
            vals[p.name] = body.slice(o, o + n);
            o += n;
          } else vals[p.name] = body[o++];
        }
        collect(e.name, vals);
      }
    }
  } else {
    const le = format === 'binary_little_endian';
    const view = new DataView(data, headerEnd);
    let o = 0;
    const read = (type: string): number => {
      let v: number;
      switch (type) {
        case 'char': case 'int8': v = view.getInt8(o); o += 1; break;
        case 'uchar': case 'uint8': v = view.getUint8(o); o += 1; break;
        case 'short': case 'int16': v = view.getInt16(o, le); o += 2; break;
        case 'ushort': case 'uint16': v = view.getUint16(o, le); o += 2; break;
        case 'int': case 'int32': v = view.getInt32(o, le); o += 4; break;
        case 'uint': case 'uint32': v = view.getUint32(o, le); o += 4; break;
        case 'float': case 'float32': v = view.getFloat32(o, le); o += 4; break;
        case 'double': case 'float64': v = view.getFloat64(o, le); o += 8; break;
        default: throw new Error(`PLY type ${type} not supported`);
      }
      return v;
    };
    for (const e of elems) {
      for (let i = 0; i < e.count; i++) {
        const vals: Record<string, number | number[]> = {};
        for (const p of e.props) {
          if (p.list) {
            const n = read(p.list[0]);
            const arr: number[] = [];
            for (let k = 0; k < n; k++) arr.push(read(p.list[1]));
            vals[p.name] = arr;
          } else vals[p.name] = read(p.type);
        }
        collect(e.name, vals);
      }
    }
  }
  function collect(name: string, vals: Record<string, number | number[]>) {
    if (name === 'vertex') verts.push(vals.x as number, vals.y as number, vals.z as number);
    else if (name === 'face') {
      const f = (vals.vertex_indices ?? vals.vertex_index) as number[];
      for (let k = 1; k + 1 < f.length; k++) idx.push(f[0], f[k], f[k + 1]);
    }
  }
  return weld(verts, idx);
}

function findHeaderEnd(bytes: Uint8Array): number {
  const marker = 'end_header';
  for (let i = 0; i < Math.min(bytes.length, 65536); i++) {
    let ok = true;
    for (let k = 0; k < marker.length; k++) if (bytes[i + k] !== marker.charCodeAt(k)) { ok = false; break; }
    if (ok) {
      let j = i + marker.length;
      while (bytes[j] === 13 || bytes[j] === 10) { j++; if (bytes[j - 1] === 10) break; }
      return j;
    }
  }
  throw new Error('Invalid PLY header');
}

// ---------- 3MF ----------

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 3MF transform "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" -> column-major 4x4. */
function parse3mfTransform(s: string | undefined): number[] {
  if (!s) return IDENTITY;
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12) return IDENTITY;
  // 3MF uses row vectors: p' = p * M, so the 3x4 rows are basis vectors.
  return [v[0], v[1], v[2], 0, v[3], v[4], v[5], 0, v[6], v[7], v[8], 0, v[9], v[10], v[11], 1];
}

function mul(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m?.[1];
}

interface Obj3mf {
  mesh?: TriMesh;
  components: { objectId: string; path?: string; transform: number[] }[];
}

/**
 * Reads every object in a 3MF, following components (Bambu/Orca store meshes
 * in separate model files) and build-item transforms, and returns one merged
 * mesh in plate coordinates.
 */
/**
 * Read three numeric attributes from every <tag .../> element. Uses a fast
 * regex for the usual attribute order and falls back to a general one.
 */
function readTriples(xml: string, tag: string, a: string, b: string, c: string): number[] {
  // Hand-rolled scan: much faster than regex on 100+ MB model files.
  const out: number[] = [];
  const open = `<${tag}`;
  const keys = [` ${a}="`, ` ${b}="`, ` ${c}="`];
  let i = xml.indexOf(open);
  while (i >= 0) {
    const close = xml.indexOf('>', i);
    if (close < 0) break;
    for (const k of keys) {
      let at = xml.indexOf(k, i);
      if (at < 0 || at > close) {
        // Attribute separated by a tab/newline: fall back to the regex helper.
        const v = attr(xml.slice(i, close), k.trim().slice(0, -2));
        out.push(v === undefined ? NaN : +v);
        continue;
      }
      at += k.length;
      out.push(+xml.slice(at, xml.indexOf('"', at)));
    }
    i = xml.indexOf(open, close);
  }
  return out;
}

export async function parse3MF(data: ArrayBuffer): Promise<TriMesh> {
  const zip = await JSZip.loadAsync(data);
  const modelFiles = Object.keys(zip.files).filter((f) => f.toLowerCase().endsWith('.model'));
  if (!modelFiles.length) throw new Error('No 3D model found in this 3MF');
  const objects = new Map<string, Obj3mf>(); // key: path#id
  const texts: Record<string, string> = {};
  for (const f of modelFiles) {
    const path = '/' + f.replace(/^\//, '');
    texts[path] = await zip.files[f].async('string');
  }
  for (const [path, xml] of Object.entries(texts)) {
    const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
    let om: RegExpExecArray | null;
    while ((om = objRe.exec(xml))) {
      const id = attr(om[1], 'id')!;
      const body = om[2];
      const o: Obj3mf = { components: [] };
      const meshM = /<mesh>([\s\S]*?)<\/mesh>/.exec(body);
      if (meshM) {
        o.mesh = { positions: new Float32Array(readTriples(meshM[1], 'vertex', 'x', 'y', 'z')), indices: new Uint32Array(readTriples(meshM[1], 'triangle', 'v1', 'v2', 'v3')) };
      }
      const cRe = /<component\b([^>]*)\/>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cRe.exec(body))) {
        o.components.push({
          objectId: attr(cm[1], 'objectid')!,
          path: attr(cm[1], 'p:path'),
          transform: parse3mfTransform(attr(cm[1], 'transform')),
        });
      }
      objects.set(`${path}#${id}`, o);
    }
  }
  const rootPath = Object.keys(texts).find((p) => /\/3D\/3dmodel\.model$/i.test(p)) ?? Object.keys(texts)[0];
  const parts: TriMesh[] = [];
  const emit = (path: string, id: string, mat: number[], depth: number) => {
    const o = objects.get(`${path}#${id}`);
    if (!o || depth > 16) return;
    if (o.mesh) parts.push(transformMesh(o.mesh, mat));
    for (const c of o.components) emit(c.path ?? path, c.objectId, mul(mat, c.transform), depth + 1);
  };
  const buildRe = /<item\b([^>]*)\/>/g;
  let bm: RegExpExecArray | null;
  let items = 0;
  while ((bm = buildRe.exec(texts[rootPath]))) {
    items++;
    emit(attr(bm[1], 'p:path') ?? rootPath, attr(bm[1], 'objectid')!, parse3mfTransform(attr(bm[1], 'transform')), 0);
  }
  if (!items) for (const key of objects.keys()) { const [p, id] = key.split('#'); emit(p, id, IDENTITY, 0); }
  if (!parts.length) throw new Error('This 3MF has no mesh data');
  return mergeMeshes(parts);
}

export function mergeMeshes(parts: TriMesh[]): TriMesh {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.positions.length; ni += p.indices.length; }
  const pos = new Float32Array(nv);
  const idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const p of parts) {
    pos.set(p.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < p.indices.length; i++) idx[io + i] = p.indices[i] + base;
    vo += p.positions.length;
    io += p.indices.length;
  }
  return weld(pos, idx, 1e-5);
}
