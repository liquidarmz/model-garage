/**
 * Printer profiles. Build volumes come from the manufacturers' published specs
 * (see README "Printer data" for sources). For multi-nozzle machines we use the
 * single-nozzle volume, which is the safe envelope for "does this part fit".
 */
export interface PrinterProfile {
  id: string;
  name: string;
  /** Usable build volume in mm: [x, y, z]. */
  volume: [number, number, number];
  /** How many filaments it can print in one job without manual swaps. */
  maxColors: number;
  slicer: 'Bambu Studio' | 'Snapmaker Orca';
  note?: string;
}

export const PRINTERS: PrinterProfile[] = [
  { id: 'bambu-p2s', name: 'Bambu Lab P2S', volume: [256, 256, 256], maxColors: 4, slicer: 'Bambu Studio', note: '4 colors per AMS unit' },
  { id: 'bambu-x2d', name: 'Bambu Lab X2D', volume: [256, 256, 260], maxColors: 8, slicer: 'Bambu Studio', note: 'Dual-nozzle overlap is 235.5 mm wide' },
  { id: 'bambu-h2c', name: 'Bambu Lab H2C', volume: [305, 320, 325], maxColors: 8, slicer: 'Bambu Studio', note: 'Single-nozzle volume; dual is 300 mm wide' },
  { id: 'bambu-h3c', name: 'Bambu Lab H3C', volume: [330, 320, 325], maxColors: 9, slicer: 'Bambu Studio', note: '9 toolheads' },
  { id: 'snapmaker-u1', name: 'Snapmaker U1', volume: [270, 270, 270], maxColors: 4, slicer: 'Snapmaker Orca', note: '4 toolheads' },
];

export const DEFAULT_PRINTER = PRINTERS[0];

/** Edge clearance we keep from the plate border when checking fit. */
export const PLATE_MARGIN = 5;

/**
 * True if a box of the given size fits the printer, allowing a 90 degree turn
 * on the plate (swap x/y). Z is the printed height.
 */
export function fitsPrinter(size: [number, number, number], p: PrinterProfile): boolean {
  const [px, py, pz] = p.volume.map((v) => v - PLATE_MARGIN * 2) as [number, number, number];
  const [x, y, z] = size;
  if (z > pz + PLATE_MARGIN * 2) return false;
  return (x <= px && y <= py) || (y <= px && x <= py);
}

/** True if the box fits in any of the 6 axis-aligned orientations. */
export function fitsPrinterAnyOrientation(size: [number, number, number], p: PrinterProfile): boolean {
  const [a, b, c] = size;
  const perms: [number, number, number][] = [
    [a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a],
  ];
  return perms.some((s) => fitsPrinter(s, p));
}

/**
 * Where plate `i` of `count` starts, matching how Bambu Studio and Orca lay
 * out multiple plates: a grid ceil(sqrt(count)) wide, each plate 1.2x its
 * size apart, extra rows going toward -Y.
 */
export function plateOrigin(i: number, count: number, p: PrinterProfile): [number, number] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const [w, d] = p.volume;
  return [(i % cols) * w * 1.2, -Math.floor(i / cols) * d * 1.2];
}
