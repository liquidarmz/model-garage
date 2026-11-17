import { useEffect, useMemo, useRef } from 'react';
import { Canvas, type ThreeEvent, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from '@react-three/drei';
import * as THREE from 'three';
import { useStore, type PartView, type PlacedView } from './store';
import { planeBasis } from '../core/geometry';
import type { TriMesh, Vec3 } from '../core/mesh';

const PART_TINTS = ['#9FB7D9', '#E0A96D', '#9CCB9A', '#D99AB5', '#C9B6E4', '#E6D27A', '#8FD1CF', '#E39A8D'];

/** Non-indexed geometry with per-vertex colors, one color per triangle. */
function useColoredGeometry(mesh: TriMesh, colors: Uint8Array, palette: string[], version: number, tint?: string) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = mesh.indices.length;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = mesh.indices[i] * 3;
      pos[i * 3] = mesh.positions[v];
      pos[i * 3 + 1] = mesh.positions[v + 1];
      pos[i * 3 + 2] = mesh.positions[v + 2];
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }, [mesh]);
  useEffect(() => {
    const attr = geom.getAttribute('color') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const pal = palette.map((c) => new THREE.Color(c));
    const tintC = tint ? new THREE.Color(tint) : null;
    const tris = colors.length;
    for (let t = 0; t < tris; t++) {
      const slot = colors[t];
      // Unpainted (slot 0) shows the part's tint while chopping so parts are easy to tell apart.
      const c = slot === 0 && tintC ? tintC : pal[slot] ?? pal[0];
      for (let k = 0; k < 3; k++) {
        arr[(t * 3 + k) * 3] = c.r;
        arr[(t * 3 + k) * 3 + 1] = c.g;
        arr[(t * 3 + k) * 3 + 2] = c.b;
      }
    }
    attr.needsUpdate = true;
  }, [geom, colors, palette, version, tint]);
  useEffect(() => () => geom.dispose(), [geom]);
  return geom;
}

function PartMesh({ part, offset, tint, selected }: { part: PartView; offset: Vec3; tint?: string; selected: boolean }) {
  const palette = useStore((s) => s.palette);
  const step = useStore((s) => s.step);
  const paintAt = useStore((s) => s.paintAt);
  const selectPart = useStore((s) => s.selectPart);
  const geom = useColoredGeometry(part.mesh, part.paint.colors, palette, part.version, tint);
  const painting = useRef(false);
  const ref = useRef<THREE.Mesh>(null);

  const handle = (e: ThreeEvent<PointerEvent>) => {
    if (step !== 'paint' || e.faceIndex == null || !ref.current) return;
    e.stopPropagation();
    const local = ref.current.worldToLocal(e.point.clone());
    paintAt(part.id, e.faceIndex, [local.x, local.y, local.z]);
  };
  return (
    <mesh
      ref={ref}
      geometry={geom}
      position={offset}
      castShadow
      receiveShadow
      onPointerDown={(e) => {
        if (step === 'paint') {
          painting.current = true;
          handle(e);
        } else if (step !== 'drop') {
          e.stopPropagation();
          selectPart(part.id);
        }
      }}
      onPointerMove={(e) => {
        if (painting.current && useStore.getState().paintTool === 'brush' && e.buttons === 1) handle(e);
      }}
      onPointerUp={() => (painting.current = false)}
      onPointerLeave={() => (painting.current = false)}
    >
      <meshStandardMaterial vertexColors roughness={0.55} metalness={0.05} emissive={selected ? '#334455' : '#000000'} />
    </mesh>
  );
}

function PlacedMesh({ p }: { p: PlacedView }) {
  const palette = useStore((s) => s.palette);
  const geom = useColoredGeometry(p.mesh, p.colors, palette, 0);
  return (
    <mesh geometry={geom} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.55} />
    </mesh>
  );
}

function CutPlanes() {
  const cuts = useStore((s) => s.cuts);
  const selected = useStore((s) => s.selectedCutId);
  const step = useStore((s) => s.step);
  const base = useStore((s) => s.base);
  const selectCut = useStore((s) => s.selectCut);
  const radius = useMemo(() => {
    if (!base) return 50;
    const b = base.bounds;
    return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.38;
  }, [base]);
  if (step !== 'chop' || !base) return null;
  return (
    <>
      {cuts.map((c) => {
        const { u, v, n } = planeBasis(c.plane.normal);
        const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...u), new THREE.Vector3(...v), new THREE.Vector3(...n));
        const q = new THREE.Quaternion().setFromRotationMatrix(m);
        const isSel = c.id === selected;
        return (
          <mesh key={c.id} position={c.anchor} quaternion={q} onPointerDown={(e) => { e.stopPropagation(); selectCut(c.id); }}>
            <circleGeometry args={[radius, 64]} />
            <meshBasicMaterial color={isSel ? '#FF7A1A' : '#FFB566'} transparent opacity={isSel ? 0.45 : 0.22} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        );
      })}
    </>
  );
}

function Plate() {
  const printer = useStore((s) => s.printer);
  const step = useStore((s) => s.step);
  const placed = useStore((s) => s.placed);
  const [w, d] = printer.volume;
  const plates = step === 'print' && placed.length ? Math.max(...placed.map((p) => p.plate)) + 1 : 1;
  return (
    <>
      {Array.from({ length: plates }, (_, i) => {
        // In print view parts sit in plate coords (0..W); elsewhere the model is centered at the origin.
        const cx = step === 'print' ? w / 2 + i * (w + 20) : 0;
        const cy = step === 'print' ? d / 2 : 0;
        return (
          <group key={i}>
            <mesh position={[cx, cy, -0.6]} receiveShadow>
              <boxGeometry args={[w, d, 1.2]} />
              <meshStandardMaterial color="#2a2f38" roughness={0.9} />
            </mesh>
            <Grid
              position={[cx, cy, 0.05]}
              rotation={[Math.PI / 2, 0, 0]}
              args={[w, d]}
              cellSize={10}
              sectionSize={50}
              cellColor="#3d4552"
              sectionColor="#56627a"
              fadeDistance={4000}
              infiniteGrid={false}
            />
          </group>
        );
      })}
    </>
  );
}

function FitCamera() {
  const base = useStore((s) => s.base);
  const step = useStore((s) => s.step);
  const printer = useStore((s) => s.printer);
  const placed = useStore((s) => s.placed);
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3; update(): void } | null };
  useEffect(() => {
    let center = new THREE.Vector3(0, 0, 0);
    let size = 200;
    if (step === 'print' && placed.length) {
      const plates = Math.max(...placed.map((p) => p.plate)) + 1;
      const totalW = plates * printer.volume[0] + (plates - 1) * 20;
      center = new THREE.Vector3(totalW / 2, printer.volume[1] / 2, 0);
      size = Math.max(totalW, printer.volume[1]);
    } else if (base) {
      const b = base.bounds;
      center = new THREE.Vector3(0, 0, (b.max[2] + b.min[2]) / 2);
      size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 120);
    }
    // Scene is Z-up inside a rotated group; convert target to three's Y-up world.
    const target = new THREE.Vector3(center.x, center.z, -center.y);
    camera.position.set(target.x + size * 1.0, target.y + size * 0.75, target.z + size * 1.55);
    camera.near = size / 100;
    camera.far = size * 40;
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
  }, [base, step, placed.length, printer, camera, controls]);
  return null;
}

export default function Viewport() {
  const parts = useStore((s) => s.parts);
  const step = useStore((s) => s.step);
  const explode = useStore((s) => s.explode);
  const placed = useStore((s) => s.placed);
  const selectedPartId = useStore((s) => s.selectedPartId);
  const selectPart = useStore((s) => s.selectPart);
  const base = useStore((s) => s.base);

  const offsets = useMemo(() => {
    const out = new Map<string, Vec3>();
    if (!base) return out;
    const b = base.bounds;
    const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const scale = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    let pinIdx = 0;
    for (const p of parts) {
      if (p.kind === 'pin') {
        // Line pins up beside the model.
        out.set(p.id, [b.max[0] + 25 + (pinIdx % 4) * 18, b.min[1] + Math.floor(pinIdx / 4) * 18, 0]);
        pinIdx++;
        continue;
      }
      const pb = p.bounds;
      const pc: Vec3 = [(pb.min[0] + pb.max[0]) / 2, (pb.min[1] + pb.max[1]) / 2, (pb.min[2] + pb.max[2]) / 2];
      const d: Vec3 = [pc[0] - c[0], pc[1] - c[1], pc[2] - c[2]];
      const len = Math.hypot(...d) || 1;
      out.set(p.id, [(d[0] / len) * scale * explode * 0.6, (d[1] / len) * scale * explode * 0.6, Math.max(-pb.min[2], (d[2] / len) * scale * explode * 0.6)]);
    }
    return out;
  }, [parts, explode, base]);

  const showTint = step === 'chop' || step === 'connect';
  const tints = useMemo(() => {
    const m = new Map<string, string>();
    let i = 0;
    for (const p of parts) m.set(p.id, p.kind === 'pin' ? '#d9d9d9' : PART_TINTS[i++ % PART_TINTS.length]);
    return m;
  }, [parts]);
  return (
    <Canvas shadows camera={{ fov: 40, position: [400, 300, 500] }} onPointerMissed={() => selectPart(null)} style={{ background: 'radial-gradient(circle at 50% 35%, #1f2530 0%, #12151b 70%)' }}>
      <hemisphereLight args={['#dfe8ff', '#1b1e24', 0.7]} />
      <directionalLight position={[300, 600, 400]} intensity={1.6} castShadow shadow-mapSize={[2048, 2048]} />
      <directionalLight position={[-400, 200, -300]} intensity={0.5} />
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <Plate />
        {step === 'print' && placed.length
          ? placed.map((p) => <PlacedMesh key={p.id} p={p} />)
          : parts.map((p) => {
              const tint = tints.get(p.id);
              return <PartMesh key={p.id} part={p} offset={offsets.get(p.id) ?? [0, 0, 0]} tint={showTint && parts.length > 1 ? tint : undefined} selected={p.id === selectedPartId} />;
            })}
        <CutPlanes />
      </group>
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} mouseButtons={{ LEFT: step === 'paint' ? undefined as never : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: step === 'paint' ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN }} />
      <FitCamera />
      <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
        <GizmoViewport axisColors={['#e5534b', '#57ab5a', '#539bf5']} labelColor="white" />
      </GizmoHelper>
    </Canvas>
  );
}
