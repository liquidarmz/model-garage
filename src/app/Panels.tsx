import { useRef, useState } from 'react';
import { useStore, STEPS } from './store';
import { PRINTERS } from '../core/printers';
import { CONNECTOR_INFO, type ConnectorType } from '../core/connectors';
import { planeBasis } from '../core/geometry';
import type { Vec3 } from '../core/mesh';

const fmt = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));
const sizeStr = (s: Vec3) => `${fmt(s[0])} x ${fmt(s[1])} x ${fmt(s[2])} mm`;

export function TopBar() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const step = useStore((s) => s.step);
  const setStep = useStore((s) => s.setStep);
  const base = useStore((s) => s.base);
  const printer = useStore((s) => s.printer);
  const setPrinter = useStore((s) => s.setPrinter);
  const idx = STEPS.findIndex((s) => s.id === step);
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">MG</span>
        <span>Model Garage</span>
      </div>
      <nav className="rail" aria-label="Steps">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            className={`rail-step ${s.id === step ? 'active' : ''} ${i < idx ? 'done' : ''}`}
            disabled={!base && s.id !== 'drop'}
            onClick={() => setStep(s.id)}
          >
            <span className="num">{i + 1}</span>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="top-right">
        <select value={printer.id} onChange={(e) => setPrinter(e.target.value)} aria-label="Printer">
          {PRINTERS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <div className="mode-toggle" role="group" aria-label="Mode">
          <button className={mode === 'chop' ? 'on' : ''} onClick={() => setMode('chop')}>Chop Shop</button>
          <button className={mode === 'workshop' ? 'on' : ''} onClick={() => setMode('workshop')}>Workshop</button>
        </div>
      </div>
    </header>
  );
}

export function DropPanel() {
  const loadFile = useStore((s) => s.loadFile);
  const loadSample = useStore((s) => s.loadSample);
  const health = useStore((s) => s.health);
  const fileName = useStore((s) => s.fileName);
  const repairs = useStore((s) => s.repairs);
  const printer = useStore((s) => s.printer);
  const parts = useStore((s) => s.parts);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="panel-body">
      <h2>Drop a model</h2>
      <p className="muted">STL, OBJ, PLY or 3MF. Drag it anywhere onto the window.</p>
      <button className="primary wide" onClick={() => input.current?.click()}>Choose a file</button>
      <input ref={input} type="file" accept=".stl,.obj,.ply,.3mf" hidden onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
      <button className="ghost wide" onClick={loadSample}>Try the sample figure</button>
      {health && (
        <div className="card">
          <div className="card-title">{fileName}</div>
          <HealthBadge ok={health.watertight || repairs.length > 0} label={repairs.length ? 'Repaired and ready' : 'Healthy mesh'} />
          <dl className="kv">
            <dt>Size</dt><dd>{sizeStr(health.size)}</dd>
            <dt>Triangles</dt><dd>{health.triangles.toLocaleString()}</dd>
            <dt>Fits {printer.name}</dt><dd>{parts[0]?.fits ? 'Yes, in one piece' : 'No, it needs cutting'}</dd>
          </dl>
          {repairs.length > 0 && <ul className="fixes">{repairs.map((r) => <li key={r}>{r}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}

function HealthBadge({ ok, label }: { ok: boolean; label: string }) {
  return <div className={`badge ${ok ? 'ok' : 'warn'}`}>{ok ? '✓' : '!'} {label}</div>;
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="scorebar">
      <span>{label}</span>
      <div className="bar"><div style={{ width: `${value}%` }} /></div>
      <b>{value}</b>
    </div>
  );
}

export function ChopPanel() {
  const plans = useStore((s) => s.plans);
  const selectedPlanId = useStore((s) => s.selectedPlanId);
  const selectPlan = useStore((s) => s.selectPlan);
  const suggest = useStore((s) => s.suggest);
  const parts = useStore((s) => s.parts);
  const setStep = useStore((s) => s.setStep);
  const printer = useStore((s) => s.printer);
  const tooBig = parts.filter((p) => p.kind === 'part' && !p.fits).length;
  return (
    <div className="panel-body">
      <h2>Where to cut</h2>
      <p className="muted">Pick a plan. Click a seam in the 3D view to fine-tune it.</p>
      {plans.map((p) => (
        <button key={p.id} className={`plan ${p.id === selectedPlanId ? 'selected' : ''}`} onClick={() => selectPlan(p.id)}>
          <div className="plan-head">
            <span className="plan-name">{p.preset.name}</span>
            <span className="plan-score">{p.scores.overall}</span>
          </div>
          <div className="plan-tag">{p.preset.tagline}</div>
          <div className="plan-sum">{p.summary}</div>
          <ScoreBar label="Hidden seams" value={p.scores.hidden} />
          <ScoreBar label="Printability" value={p.scores.printability} />
          <ScoreBar label="Simplicity" value={p.scores.simplicity} />
        </button>
      ))}
      {!plans.length && <button className="primary wide" onClick={suggest}>Suggest cuts</button>}
      <SeamEditor />
      <div className="card">
        <div className="card-title">{parts.filter((p) => p.kind === 'part').length} parts</div>
        {tooBig > 0
          ? <HealthBadge ok={false} label={`${tooBig} part${tooBig > 1 ? 's' : ''} still too big for the ${printer.name}`} />
          : <HealthBadge ok label={`Every part fits the ${printer.name}`} />}
      </div>
      <ExplodeSlider />
      <button className="primary wide" disabled={!parts.length} onClick={() => setStep('connect')}>Next: connectors</button>
    </div>
  );
}

function SeamEditor() {
  const cuts = useStore((s) => s.cuts);
  const selectedCutId = useStore((s) => s.selectedCutId);
  const selectCut = useStore((s) => s.selectCut);
  const moveCut = useStore((s) => s.moveCut);
  const tiltCutBy = useStore((s) => s.tiltCutBy);
  const removeCut = useStore((s) => s.removeCut);
  const commitCuts = useStore((s) => s.commitCuts);
  const base = useStore((s) => s.base);
  if (!cuts.length || !base) return null;
  const b = base.bounds;
  return (
    <div className="card">
      <div className="card-title">Seams</div>
      <ol className="seams">
        {cuts.map((c, i) => {
          const sel = c.id === selectedCutId;
          const n = c.plane.normal;
          // Offset range: project the bounding box onto the normal.
          let lo = 0, hi = 0;
          for (let k = 0; k < 3; k++) {
            lo += n[k] * (n[k] >= 0 ? b.min[k] : b.max[k]);
            hi += n[k] * (n[k] >= 0 ? b.max[k] : b.min[k]);
          }
          const { u } = planeBasis(n);
          return (
            <li key={c.id} className={sel ? 'sel' : ''}>
              <button className="seam-title" onClick={() => selectCut(sel ? null : c.id)}>
                <span>Seam {i + 1}</span>
                <small>{c.reasons[0]}</small>
              </button>
              {sel && (
                <div className="seam-edit">
                  <ul className="reasons">{c.reasons.slice(1).map((r) => <li key={r}>{r}</li>)}</ul>
                  <label>Slide
                    <input type="range" min={lo + 1} max={hi - 1} step={0.5} value={c.plane.offset}
                      onChange={(e) => moveCut(c.id, +e.target.value)} onPointerUp={() => commitCuts()} onKeyUp={() => commitCuts()} />
                  </label>
                  <div className="row">
                    <button className="small" onClick={() => { tiltCutBy(c.id, u, -5); void commitCuts(); }}>Tilt -5°</button>
                    <button className="small" onClick={() => { tiltCutBy(c.id, u, 5); void commitCuts(); }}>Tilt +5°</button>
                    <button className="small danger" onClick={() => removeCut(c.id)}>Remove</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ExplodeSlider() {
  const explode = useStore((s) => s.explode);
  const setExplode = useStore((s) => s.setExplode);
  return (
    <label className="slider">Spread parts
      <input type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setExplode(+e.target.value)} />
    </label>
  );
}

const TYPES: ConnectorType[] = ['dowel', 'pin', 'socket', 'dovetail', 'snap', 'magnet', 'none'];

function ConnectorIcon({ type }: { type: ConnectorType }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2 } as const;
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden>
      {type === 'dowel' && <><rect x="12" y="4" width="8" height="24" rx="2" {...common} /><line x1="6" y1="16" x2="26" y2="16" {...common} strokeDasharray="3 2" /></>}
      {type === 'pin' && <><rect x="12" y="6" width="8" height="12" rx="2" {...common} /><rect x="4" y="18" width="24" height="8" {...common} /></>}
      {type === 'socket' && <><rect x="7" y="12" width="18" height="6" rx="2" {...common} /><rect x="4" y="18" width="24" height="8" {...common} /></>}
      {type === 'dovetail' && <><path d="M11 18 L8 8 L24 8 L21 18 Z" {...common} /><rect x="4" y="18" width="24" height="8" {...common} /></>}
      {type === 'snap' && <><path d="M12 18 V9 L10 7 M20 18 V9 L22 7" {...common} /><line x1="16" y1="18" x2="16" y2="9" {...common} /><rect x="4" y="18" width="24" height="8" {...common} /></>}
      {type === 'magnet' && <><path d="M9 6 V16 a7 7 0 0 0 14 0 V6" {...common} /><line x1="9" y1="10" x2="13" y2="10" {...common} /><line x1="19" y1="10" x2="23" y2="10" {...common} /></>}
      {type === 'none' && <><rect x="4" y="12" width="24" height="8" {...common} /></>}
    </svg>
  );
}

export function ConnectPanel() {
  const connector = useStore((s) => s.connector);
  const setConnector = useStore((s) => s.setConnector);
  const apply = useStore((s) => s.applyConnectors);
  const applied = useStore((s) => s.connectorsApplied);
  const cuts = useStore((s) => s.cuts);
  const setCutConnector = useStore((s) => s.setCutConnector);
  const warnings = useStore((s) => s.warnings);
  const parts = useStore((s) => s.parts);
  const setStep = useStore((s) => s.setStep);
  const pins = parts.filter((p) => p.kind === 'pin').length;
  return (
    <div className="panel-body">
      <h2>Connectors</h2>
      <p className="muted">One style for every seam. Change single seams below.</p>
      <div className="conn-grid">
        {TYPES.map((t) => (
          <button key={t} className={`conn ${connector.type === t ? 'on' : ''}`} onClick={() => setConnector({ type: t })} title={CONNECTOR_INFO[t].blurb}>
            <ConnectorIcon type={t} />
            <span>{CONNECTOR_INFO[t].label}</span>
          </button>
        ))}
      </div>
      <p className="hint">{CONNECTOR_INFO[connector.type].blurb}</p>
      {connector.type !== 'none' && (
        <>
          {connector.type !== 'magnet' ? (
            <label className="slider">Size {connector.diameter ? `${connector.diameter} mm` : '(auto)'}
              <input type="range" min={0} max={12} step={0.5} value={connector.diameter} onChange={(e) => setConnector({ diameter: +e.target.value })} />
            </label>
          ) : (
            <div className="row">
              <label className="num-in">Magnet Ø<input type="number" min={2} max={20} step={0.5} value={connector.magnet.diameter} onChange={(e) => setConnector({ magnet: { ...connector.magnet, diameter: +e.target.value } })} /></label>
              <label className="num-in">Height<input type="number" min={1} max={10} step={0.5} value={connector.magnet.height} onChange={(e) => setConnector({ magnet: { ...connector.magnet, height: +e.target.value } })} /></label>
            </div>
          )}
          <label className="slider">Fit clearance {connector.clearance.toFixed(2)} mm
            <input type="range" min={0} max={0.5} step={0.05} value={connector.clearance} onChange={(e) => setConnector({ clearance: +e.target.value })} />
          </label>
          <label className="slider">Per seam {connector.count || '(auto)'}
            <input type="range" min={0} max={4} step={1} value={connector.count} onChange={(e) => setConnector({ count: +e.target.value })} />
          </label>
        </>
      )}
      {cuts.length > 1 && (
        <div className="card">
          <div className="card-title">Per seam</div>
          {cuts.map((c, i) => (
            <div key={c.id} className="row seam-row">
              <span>Seam {i + 1}</span>
              <select value={c.connector?.type ?? ''} onChange={(e) => setCutConnector(c.id, e.target.value ? { type: e.target.value as ConnectorType } : null)}>
                <option value="">Same as all</option>
                {TYPES.map((t) => <option key={t} value={t}>{CONNECTOR_INFO[t].label}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
      <button className="primary wide" onClick={apply}>{applied ? 'Rebuild connectors' : 'Add connectors'}</button>
      {applied && (
        <div className="card">
          <HealthBadge ok label={`Connectors added${pins ? `, plus ${pins} loose pin${pins > 1 ? 's' : ''} to print` : ''}`} />
          {warnings.map((w) => <div key={w} className="badge warn">! {w}</div>)}
        </div>
      )}
      <ExplodeSlider />
      <button className="primary wide" onClick={() => setStep('paint')}>Next: paint</button>
    </div>
  );
}

export function PaintPanel() {
  const palette = useStore((s) => s.palette);
  const slotCount = useStore((s) => s.slotCount);
  const activeSlot = useStore((s) => s.activeSlot);
  const tool = useStore((s) => s.paintTool);
  const brush = useStore((s) => s.brushRadius);
  const angle = useStore((s) => s.smartAngle);
  const setPaint = useStore((s) => s.setPaint);
  const setColor = useStore((s) => s.setPaletteColor);
  const fillByPart = useStore((s) => s.fillPartsByIndex);
  const printer = useStore((s) => s.printer);
  const setStep = useStore((s) => s.setStep);
  return (
    <div className="panel-body">
      <h2>Paint</h2>
      <p className="muted">Left-click paints. Right-drag turns the view.</p>
      <div className="card">
        <div className="card-title">Filaments ({slotCount} of {printer.maxColors} on the {printer.name})</div>
        <div className="swatches">
          {palette.slice(0, slotCount).map((c, i) => (
            <div key={i} className={`swatch ${i === activeSlot ? 'on' : ''}`} onClick={() => setPaint({ activeSlot: i })}>
              <span style={{ background: c }} />
              <input type="color" value={c} onChange={(e) => setColor(i, e.target.value)} aria-label={`Filament ${i + 1} color`} />
              <small>{i + 1}</small>
            </div>
          ))}
          {slotCount < Math.min(printer.maxColors, palette.length) && <button className="swatch add" onClick={() => setPaint({ slotCount: slotCount + 1 })}>+</button>}
        </div>
      </div>
      <div className="seg">
        {(['part', 'smart', 'brush'] as const).map((t) => (
          <button key={t} className={tool === t ? 'on' : ''} onClick={() => setPaint({ paintTool: t })}>
            {t === 'part' ? 'Whole part' : t === 'smart' ? 'Smart fill' : 'Brush'}
          </button>
        ))}
      </div>
      {tool === 'brush' && (
        <label className="slider">Brush size {brush} mm
          <input type="range" min={1} max={40} step={1} value={brush} onChange={(e) => setPaint({ brushRadius: +e.target.value })} />
        </label>
      )}
      {tool === 'smart' && (
        <label className="slider">Stop at edges sharper than {angle}°
          <input type="range" min={5} max={80} step={1} value={angle} onChange={(e) => setPaint({ smartAngle: +e.target.value })} />
        </label>
      )}
      <button className="ghost wide" onClick={fillByPart}>Color each part differently</button>
      <ExplodeSlider />
      <button className="primary wide" onClick={() => setStep('print')}>Next: print</button>
    </div>
  );
}

export function PrintPanel() {
  const placed = useStore((s) => s.placed);
  const parts = useStore((s) => s.parts);
  const printer = useStore((s) => s.printer);
  const exportProject = useStore((s) => s.exportProject);
  const plates = placed.length ? Math.max(...placed.map((p) => p.plate)) + 1 : 0;
  const tooBig = parts.filter((p) => p.kind === 'part' && !p.fits);
  return (
    <div className="panel-body">
      <h2>Print</h2>
      <p className="muted">Each part sits on its flat cut face, laid out for the {printer.name}.</p>
      <div className="card">
        <div className="card-title">{placed.length} pieces on {plates} plate{plates === 1 ? '' : 's'}</div>
        <ul className="part-list">
          {parts.map((p) => (
            <li key={p.id}><span>{p.name}</span><small>{sizeStr(p.size)}</small>{p.kind === 'part' && !p.fits && <em>too big</em>}</li>
          ))}
        </ul>
        {tooBig.length > 0 && <div className="badge warn">! Go back to Chop to split the parts marked too big.</div>}
      </div>
      <button className="primary wide big" onClick={exportProject}>Download 3MF</button>
      <p className="hint">Open the file in {printer.slicer}. Colors come through as painted filaments; let the slicer re-arrange plates if you like.</p>
    </div>
  );
}

export function WorkshopPanel() {
  const base = useStore((s) => s.base);
  const addManualCut = useStore((s) => s.addManualCut);
  const scaleModel = useStore((s) => s.scaleModel);
  const mirrorModel = useStore((s) => s.mirrorModel);
  const cuts = useStore((s) => s.cuts);
  const [axis, setAxis] = useState<0 | 1 | 2>(2);
  const [pos, setPos] = useState(50);
  const [height, setHeight] = useState('');
  if (!base) return <div className="panel-body"><h2>Workshop</h2><p className="muted">Drop a model first.</p></div>;
  const b = base.bounds;
  const lo = b.min[axis], hi = b.max[axis];
  const offset = lo + ((hi - lo) * pos) / 100;
  const curH = b.max[2] - b.min[2];
  return (
    <div className="panel-body">
      <h2>Workshop</h2>
      <p className="muted">Hands-on tools. Changes show up in Chop Shop too.</p>
      <div className="card">
        <div className="card-title">Manual cut</div>
        <div className="seg">
          {(['X', 'Y', 'Z'] as const).map((a, i) => (
            <button key={a} className={axis === i ? 'on' : ''} onClick={() => setAxis(i as 0 | 1 | 2)}>{a}</button>
          ))}
        </div>
        <label className="slider">Position {fmt(offset)} mm
          <input type="range" min={2} max={98} step={0.5} value={pos} onChange={(e) => setPos(+e.target.value)} />
        </label>
        <button className="primary wide" onClick={() => { const n: Vec3 = [0, 0, 0]; n[axis] = 1; addManualCut(n, offset); }}>Add cut</button>
        <p className="hint">{cuts.length} cut{cuts.length === 1 ? '' : 's'} in this project. Fine-tune them in Chop.</p>
      </div>
      <div className="card">
        <div className="card-title">Size</div>
        <div className="row">
          <label className="num-in">Height (mm)<input type="number" placeholder={fmt(curH)} value={height} onChange={(e) => setHeight(e.target.value)} /></label>
          <button className="small" disabled={!+height} onClick={() => { void scaleModel(+height / curH); setHeight(''); }}>Scale</button>
        </div>
        <div className="row">
          <button className="small" onClick={() => scaleModel(0.5)}>50%</button>
          <button className="small" onClick={() => scaleModel(2)}>200%</button>
          <button className="small" onClick={() => mirrorModel(0)}>Mirror X</button>
        </div>
      </div>
      <div className="card coming">
        <div className="card-title">Coming next</div>
        <ul className="fixes">
          <li>Curved and outline cuts</li><li>Hollow and wall thickness</li><li>Articulated joints</li>
          <li>Booleans (add, subtract)</li><li>Text and logo emboss</li><li>Sculpt brushes</li>
        </ul>
      </div>
    </div>
  );
}
