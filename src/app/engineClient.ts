import type { GeometryEngine, EngineMethod } from '../core/engine';

type Fn<K extends EngineMethod> = GeometryEngine[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
export type RemoteEngine = { [K in EngineMethod]: Fn<K> } & { onProgress: (label: string) => void };

/** Talks to the geometry worker so heavy cuts never freeze the page. */
export function createEngine(): RemoteEngine {
  const worker = new Worker(new URL('../core/worker.ts', import.meta.url), { type: 'module' });
  let next = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const api = { onProgress: (_label: string) => {} } as RemoteEngine;
  worker.onmessage = (e: MessageEvent<{ id: number; ok?: boolean; result?: unknown; error?: string; progress?: string }>) => {
    const m = e.data;
    if (m.progress !== undefined) { api.onProgress(m.progress); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'The geometry worker crashed. Reload the page to continue.'));
    pending.clear();
  };
  const call = (method: EngineMethod) => (...args: unknown[]) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    const transfer = args.filter((a): a is ArrayBuffer => a instanceof ArrayBuffer);
    worker.postMessage({ id, method, args }, transfer);
  });
  for (const m of ['load', 'sample', 'scale', 'mirror', 'suggest', 'anchor', 'build', 'layout', 'dispose'] as EngineMethod[]) {
    (api as unknown as Record<string, unknown>)[m] = call(m);
  }
  return api;
}
