/// <reference lib="webworker" />
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { setWasmLocator, getKernel } from './geometry';
import { GeometryEngine, type EngineMethod } from './engine';

setWasmLocator(() => wasmUrl);
const engine = new GeometryEngine();
let current = 0;
engine.progress = (label) => postMessage({ id: current, progress: label });
void getKernel();

/** Collect typed-array buffers in a result so they move instead of copying. */
function transferables(v: unknown, out: Transferable[] = [], seen = new Set<unknown>()): Transferable[] {
  if (!v || typeof v !== 'object' || seen.has(v)) return out;
  seen.add(v);
  if (ArrayBuffer.isView(v)) {
    if (v.buffer instanceof ArrayBuffer && !out.includes(v.buffer)) out.push(v.buffer);
    return out;
  }
  for (const x of Array.isArray(v) ? v : Object.values(v)) transferables(x, out, seen);
  return out;
}

// Calls are handled one at a time, in order.
let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<{ id: number; method: EngineMethod; args: unknown[] }>) => {
  const { id, method, args } = e.data;
  queue = queue.then(async () => {
    current = id;
    try {
      const fn = engine[method] as (...a: unknown[]) => unknown;
      const result = await fn.apply(engine, args);
      postMessage({ id, ok: true, result }, { transfer: transferables(result) });
    } catch (err) {
      postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
};
