# Marut

Combat flight over India, in your browser. Fly the HAL Tejas Mk1A from Bhisiana AFS (Bathinda, Punjab), take on air-to-air missions, or just fly. No download, no sign-up.

> Early access (v0.1, wireframe build). INS Hansa (Goa) is included but not fully tested yet.

## Features

- A procedural Tejas Mk1A with real dimensions, moving control surfaces, gear, airbrakes and exterior lights
- Flight model with an F404 engine, fly-by-wire, fuel and stores weight, and ground handling
- Loadouts: ASRAAM, R-73, Derby, Astra Mk1 and drop tanks on any pylon that takes them
- Free Flight and three missions, with time of day and weather
- Streamed terrain of Punjab and Goa, with towns, roads, rivers, clouds and night lights

## Run it

Requires Node.js 18 or 20+.

```sh
npm install
npm run dev
```

Then open the URL Vite prints: `/` is the landing page, `/play/` is the game.

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run typecheck` | TypeScript, main thread and workers |
| `npm run build` | Typecheck and production build to `dist/` |

## Controls

| | |
| --- | --- |
| Pitch / roll | W S / A D |
| Throttle | Z / X, Shift for afterburner |
| Gear, lights | G, L |
| Target, fire | T, Enter |
| Look around | Right-drag or arrow keys |

The full list is under Controls in the main menu, or press F1 in flight.

## Project layout

- `src/physics`, `src/aircraft`: flight model and aircraft data
- `src/core`: simulation (runs in a web worker), missions
- `src/terrain`, `src/airport`: terrain generation and airbases
- `src/render`, `src/hud`: Three.js rendering and the HUD
- `src/ui`, `src/site`: game menus and the landing page
- `tests`: Vitest suites

## Credits

Airbase layouts for Bhisiana and Shahbaz are based on OpenStreetMap data, © OpenStreetMap contributors, available under the [Open Database License](https://opendatacommons.org/licenses/odbl/).

The Tejas 3D model (`public/models/tejas.glb`) is based on ["HAL Tejas"](https://sketchfab.com/3d-models/hal-tejas-fd95c85e2452490cbe32f80175498441) by [dimal965](https://sketchfab.com/dimal965), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: repainted grey, split into moving parts, canopy and airbrakes closed, rescaled to the game frame (`tools/models/build_tejas.py`).

The JF-17 3D model (`public/models/jf17.glb`) is based on ["JF-17"](https://sketchfab.com/3d-models/jf-17-b57660f346314df1877e15b85d6e74be) by [dimal965](https://sketchfab.com/dimal965), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: canopy closed, gear split, hinges and pylons rigged, nozzle replaced, moved to the game frame (`tools/models/build_jf17.py`).

Marut is an independent project and is not affiliated with HAL, the Indian Air Force or the Indian Navy.
