import type { Manifold } from 'manifold-3d';
import { getKernel } from './geometry';

/**
 * A chunky test figure (about 300 mm tall) built from primitives: round base,
 * legs, torso, arms and head. It has clear necks and is too tall for most
 * printers, so it exercises every part of the chop flow.
 */
export async function sampleFigure(height = 300): Promise<Manifold> {
  const { Manifold } = await getKernel();
  const s = height / 300;
  const seg = 48;
  const base = Manifold.cylinder(18, 70, 66, seg * 2);
  const leg = (x: number) => Manifold.cylinder(95, 15, 19, seg).translate([x, 0, 14]);
  const hips = Manifold.cube([78, 42, 30], true).translate([0, 0, 112]);
  const torso = Manifold.cylinder(70, 30, 42, seg).scale([1.15, 0.75, 1]).translate([0, 0, 120]);
  const shoulders = Manifold.sphere(34, seg).scale([1.45, 0.75, 0.55]).translate([0, 0, 190]);
  const arm = (x: number, dir: number) =>
    Manifold.cylinder(80, 11, 13, seg).rotate([0, dir * 162, 0]).translate([x, 0, 196])
      .add(Manifold.sphere(15, seg).translate([x + dir * 25, 0, 120]));
  const neck = Manifold.cylinder(18, 11, 11, seg).translate([0, 0, 202]);
  const head = Manifold.sphere(34, seg).scale([1, 0.95, 1.12]).translate([0, 0, 248]);
  const hat = Manifold.cylinder(14, 30, 22, seg).translate([0, 0, 278]);
  const all = Manifold.union([base, leg(-20), leg(20), hips, torso, shoulders, arm(-44, -1), arm(44, 1), neck, head, hat]);
  return s === 1 ? all : all.scale([s, s, s]);
}
