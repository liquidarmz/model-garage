import { useEffect, useState } from 'react';
import Viewport from './app/Viewport';
import { useStore } from './app/store';
import { TopBar, DropPanel, ChopPanel, ConnectPanel, PaintPanel, PrintPanel, WorkshopPanel } from './app/Panels';

export default function App() {
  const step = useStore((s) => s.step);
  const mode = useStore((s) => s.mode);
  const busy = useStore((s) => s.busy);
  const error = useStore((s) => s.error);
  const notice = useStore((s) => s.notice);
  const dismiss = useStore((s) => s.dismissNotice);
  const loadFile = useStore((s) => s.loadFile);
  const base = useStore((s) => s.base);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const over = (e: DragEvent) => { e.preventDefault(); setDragging(true); };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false); };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) void loadFile(f);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [loadFile]);

  const panel = mode === 'workshop' && step !== 'paint' && step !== 'print'
    ? <WorkshopPanel />
    : { drop: <DropPanel />, chop: <ChopPanel />, connect: <ConnectPanel />, paint: <PaintPanel />, print: <PrintPanel /> }[step];

  return (
    <div className="app">
      <TopBar />
      <main className="main">
        <section className="view">
          <Viewport />
          {!base && !busy && (
            <div className="empty">
              <div className="empty-box">
                <div className="empty-icon">⬇</div>
                <div>Drop a model here</div>
                <small>STL · OBJ · PLY · 3MF</small>
              </div>
            </div>
          )}
          {busy && <div className="busy"><span className="spinner" />{busy}…</div>}
          {(error || notice) && (
            <div className={`toast ${error ? 'err' : ''}`} onClick={dismiss}>{error ?? notice}<small>click to close</small></div>
          )}
          {dragging && <div className="dropzone">Drop to load</div>}
        </section>
        <aside className="panel">{panel}</aside>
      </main>
    </div>
  );
}
