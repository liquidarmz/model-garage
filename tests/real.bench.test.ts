import { describe, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { GeometryEngine } from '../src/core/engine'
import { PRINTERS } from '../src/core/printers'
import { DEFAULT_CONNECTOR } from '../src/core/connectors'

// Opt-in benchmark on real files: REAL_MODELS=a.3mf,b.stl SCALE=3 npx vitest run tests/real.bench.test.ts
const files = (process.env.REAL_MODELS ?? '').split(',').filter(f => f && existsSync(f))
describe.skipIf(files.length === 0)('real models', () => {
  for (const f of files) it(f, async () => {
    const t0 = performance.now(); const lap = (l: string) => console.log(l, Math.round(performance.now() - t0), 'ms')
    const eng = new GeometryEngine()
    const buf = readFileSync(f)
    let base = await eng.load(f, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
    lap(`loaded ${base.part.mesh.indices.length / 3} tris ${base.repairs.join('; ')}`)
    const k = Number(process.env.SCALE ?? 1)
    if (k !== 1) { base = await eng.scale(k); lap('scaled') }
    const plans = await eng.suggest(PRINTERS[0]); lap('plans')
    for (const p of plans) console.log(p.preset.kind, p.partCount, p.allFit, JSON.stringify(p.scores), p.summary)
    for (const plan of plans) {
      const r = await eng.build(plan.cuts, { ...DEFAULT_CONNECTOR, type: (process.env.CONN ?? 'dowel') as never }); lap('built ' + plan.preset.kind)
      console.log(r.parts.length, 'parts, placed', r.connectorsPlaced, r.warnings)
      const placed = await eng.layout(PRINTERS[0]); lap(`layout ${Math.max(...placed.map(p => p.plate)) + 1} plates`)
    }
    eng.dispose()
  }, 900000)
})
