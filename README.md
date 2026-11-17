# Model Garage

Drop in a 3D model, let the app suggest where to cut it, add connectors, paint it, and send it to your slicer.

Model Garage has two modes:

- **Chop Shop** (default): a five-step flow. **Drop** a model, **Chop** it with suggested cut plans, **Connect** the parts, **Paint** them, and **Print** a laid-out 3MF.
- **Workshop**: hands-on tools for manual cuts, scaling and mirroring. More tools are coming.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # geometry, cutting, connectors, 3MF round-trip
npm run build    # static site in dist/
```

Everything runs in the browser. Nothing is uploaded.

## What works today (milestone 1)

| Step | What it does |
| --- | --- |
| Drop | Reads STL, OBJ, PLY and 3MF (including Bambu/Orca projects that keep meshes in separate files). Fixes common problems automatically: inside-out faces, tiny gaps, loose specks. Shows size, triangle count and whether the model fits your printer. |
| Chop | Suggests three plans: **Hidden seams** (cuts at natural narrow points), **Fewest parts** (only what is needed to fit), **Easy printing** (level cuts that sit flat). Each plan is scored on hidden seams, printability and simplicity, and every seam explains why it was chosen. You can slide, tilt or remove any seam. |
| Connect | Dowel (with separate pins), pin, socket, dovetail rail, snap-fit, and magnet pockets. Size, clearance and count are automatic or set by hand, and each seam can use a different type. Connectors are kept clear of the outer wall. |
| Paint | Up to the number of filaments your printer supports. Whole-part fill, smart fill (stops at sharp edges) and a brush. |
| Print | Turns each part so a flat cut face sits on the plate, lays parts out across as many plates as needed, and exports a 3MF with per-triangle filament paint that Bambu Studio and Orca read. |

## Printer data

| Printer | Build volume used (mm) | Source |
| --- | --- | --- |
| Bambu Lab P2S | 256 x 256 x 256 | [Bambu wiki](https://wiki.bambulab.com/en/p2s/manual/p2s-faq) |
| Bambu Lab X2D | 256 x 256 x 260 (single nozzle) | [3D Printing Industry](https://3dprintingindustry.com/news/bambu-lab-launches-x2d-dual-nozzle-3d-printer-targeting-reduced-post-processing-and-material-waste-251005/) |
| Bambu Lab H2C | 305 x 320 x 325 (single nozzle) | [3D Printing Industry](https://3dprintingindustry.com/news/bambu-lab-launches-the-new-h2c-multi-material-3d-printer-technical-specifications-and-pricing-246509) |
| Bambu Lab H3C | 330 x 320 x 325 | [3D Printing Industry](https://3dprintingindustry.com/news/bambu-lab-launches-h3c-technical-specifications-and-pricing-256200/) |
| Snapmaker U1 | 270 x 270 x 270 | [Snapmaker](https://www.snapmaker.com/snapmaker-u1/specs) |

A 5 mm margin is kept from the plate edge when checking fit.

## How the smart cut works

For each axis the model is sliced about 50 times. Each slice is scored on:

- **Narrowing**: how much thinner the slice is than the model on either side (necks, wrists, waists). A seam there is short and follows a natural line.
- **Seam length**: shorter seams are easier to hide and clean up.
- **Balance**: no slivers.
- **Room for connectors**: a 5 mm connector plus a 1.6 mm wall must fit.
- **Level cut**: horizontal cuts give parts a flat base to print on.

The planner splits parts that are too big for your printer first, then (depending on the plan) keeps splitting at strong narrow points. Plans are scored by simulating the split and estimating how much overhang each part has when printed on its cut face.

## Code layout

```
src/core/       geometry kernel, no UI (tested in Node)
  geometry.ts     Manifold (WebAssembly) wrapper: solids, planes, sections
  loaders.ts      STL / OBJ / PLY / 3MF readers
  smartcut.ts     cut candidates, planner, plan scoring
  pipeline.ts     applies cuts and connectors in order
  connectors.ts   connector shapes and placement
  orient.ts       print orientation, support estimate, plate layout
  paint.ts        per-triangle filament painting
  export3mf.ts    3MF writer with slicer paint codes
  printers.ts     printer profiles
src/app/        React UI (store, viewport, panels)
tests/          Vitest suite
```

## Next up

- Run the geometry in a Web Worker so big models never freeze the window
- Curved and outline cuts, and learned part detection for organic models
- Hollowing, wall-thickness check, articulated joints, text/logo emboss
- Desktop app (Tauri) with send-to-slicer
