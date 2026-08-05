# Project knowledge

This file gives Freebuff context about this project: goals, commands, conventions, and gotchas. See `README.md` for the full user-facing docs (UI legend, shortcut table, file formats).

## What this is

**Vanilla-JS 2D mesh editor** — draw points, build triangles, save/load scenes as JSON or a custom « meshes » text format. **Zero dependencies, zero build step, zero framework.** Single page app served as static files.

The whole UI is one HTML page driving a `<canvas>`; HTML/CSS/JS are not transpiled.

## Quickstart

- **Setup:** none for the app itself (zero deps, no transpile). Dev tooling only: `npm ci` once (devDependency `playwright-core` for the smoke tests; `node_modules` is gitignored).
- **Dev:** `python3 test_server.py` from the project root → serves on `http://localhost:8000/`, then open `main.html`. The script does a real bind-check (port + connect-back probe) and exits with an error if the port is taken.
- **Test:** `npm run check` — `node --check` on all `.js`/`.mjs` + the 12 browser smoke suites (auto-starts/stops the dev server). See « Dev tooling & CI » below.
- **Lint:** none.
- **Build (optional):** `npm run build:portable` → single-file offline `meshes-portable.html` (Option A of `PORTABILITE.md`); `npm run check:portable` validates it (rebuild + static checks + `file://` browser test); `npm run check:artifact` tests the CI-published artifact (downloads the latest `meshes-portable` from the last successful `master` run via `gh` + `unzip`, same `file://` walk — `--local <file>` for a local file without CI prerequisites). See « Dev tooling & CI » below.
- **Headless import test:** `http://localhost:8000/main.html?autoimport=<base64-urlsafe-text>` triggers an auto-import of a meshes-formatted string (no file picker needed).

## Architecture

App: one HTML page driving **16 ES modules** (see the `main.html` script tags, topological order) + one Python dev server, plus assets. Dev tooling lives in `scripts/` (never shipped). Key files:

| File | Rôle |
|---|---|
| `main.html` | Layout, CSS (toolbar, HUD, modales), declares the toolbar buttons + help modal + log overlay (`#messageBoard` with drag handle + SE resize grip). Mounts the 16 JS modules. |
| `main.js` | App logic: state (`ctx`, `shapes`, selection, zoom, pan, undo/redo), mouse/keyboard events, drawing, persistence, import/export. |
| `draw.js` | Pure render primitives (points, lines, triangles, axes, grid). All coords go through `modelToScreen()`. |
| `convert.js` | Parser: meshes-format text ↔ multi-shape JSON scene. Reads files via `FileReader` (this is why HTTP serving is mandatory). |
| `test_server.py` | Threaded `http.server` on port 8000 with EADDRINUSE-diagnostics. |
| `assets/` | `barre_boutons.png` (toolbar screenshot), `meshes-sample`, `mesh-1785093938339.json`, `alphabet2` (legacy example). `assets/favicon.svg` is the only asset referenced by the app (`<link rel="icon">`). |
| `scripts/` | Dev tooling only (never shipped): `check.sh` (orchestrates `npm run check`), the 8 `smoke-*.mjs` suites + `smoke_lib.mjs` harness, and the portable toolchain `build-portable.mjs` + `check-portable.mjs` + `check-artifact.mjs` + the shared `portable-browser-test.mjs`. See « Dev tooling & CI » below. |

Data flow: `main.js` owns app state → calls render primitives in `draw.js` (post-transformation via `modelToScreen`) → user input updates state → main persists via `localStorage`.

## Dev tooling & CI (npm scripts)

| Script | What it does |
|---|---|
| `npm run check` | `bash scripts/check.sh` : `node --check` on all `.js`/`.mjs` (incl. `scripts/`) then the 11 smoke suites (`npm run smoke`) — starts/stops the dev server itself if port 8000 is free. |
| `npm run smoke[:suite]` | 12 headless browser suites (preview, edit, import, gestures, modals, rotate, circle, shapes, color, multipoint, palette, mergedrop) via `playwright-core` + harness `scripts/smoke_lib.mjs` (`CHROMIUM_PATH`, default `/usr/bin/chromium`). |
| `npm run build:portable` | `node scripts/build-portable.mjs` : merges the 16 modules into a standalone `meshes-portable.html` (Option A of `PORTABILITE.md`) — inline module escapes the `file://` CORS, localStorage shim for Firefox, comments/blank lines stripped, `node --check` self-validated. Gitignored artifact, always regenerable; sources untouched. |
| `npm run check:portable` | `node scripts/check-portable.mjs` : rebuild + static validation of the generated file (node --check of the merged script, zero residual import/export, zero blank line, shim, collision renames, source regexes verbatim) + `file://` browser test (load, click→point persisted, wheel zoom, reload restore, autoimport exercising convert.js regexes). |
| `npm run check:artifact` | `node scripts/check-artifact.mjs` : tests the **CI-published** artifact — downloads the latest `meshes-portable` from the last successful `master` run (`gh` CLI + `unzip`, repo from `git remote`, `--repo` to override), extracts, runs the SAME `file://` browser walk as check:portable via the shared `scripts/portable-browser-test.mjs` helper, cleans the temp dir. `--local <file>` tests a local file without CI prerequisites; `--out-dir`, `--keep`, `--help`. Post-CI manual check (needs a published master run), intentionally NOT in `npm run check:portable` nor in the workflow. |

- **CI** (`.github/workflows/check.yml`, on every push) : `npm run check` then `npm run check:portable`, then **uploads the artifact** (`meshes-portable.html` + `assets/`) via `actions/upload-artifact@v7`. The upload is **restricted to branch `master`** (`if: github.ref == 'refs/heads/master'`) — validations run on every branch, but branches don't produce artifacts.
- **CI policy** : actions pinned to v7 (checkout, setup-node, upload-artifact = Node 24 runtime; ≤ v4 ran on deprecated Node 20). Dependabot watches the `github-actions` ecosystem weekly (`.github/dependabot.yml`).

## Conventions

- **No build / no transpile / no bundler.** Edits + browser reload = iteration. No HMR. Exception: the optional portable build (`npm run build:portable`) concatenates the modules into one HTML — it never modifies the sources.
- **Y axis inverted.** `modelToScreen` flips Y so larger `model.y` renders higher on canvas (math-style). Mind this when touching pan or rotation math.
- **`ctx` shape:** `{ center: {x,y}, viewCenter: {x,y}, zoomLevel: number }`. `center` is pixel position of model origin on canvas (in **CSS pixels**, never bitmap pixels); `viewCenter` is which model point is centered; `zoomLevel` is a multiplier (clamp `[0.1, 10]`).
- **HiDPI:** the canvas bitmap is sized in **physical pixels** (`board.width = round(cssW × devicePixelRatio)`, boot + resize in main.js) for crisp rendering on retina displays, but ALL internal coordinates (mouse, hit-testing, `center`, `modelToScreen`) stay in **CSS pixels**. The CSS→physical conversion happens at two boundaries only: bitmap sizing in main.js, and a `setTransform(dpr,…)` applied in draw.js (`drawBoard` on the visible ctx, `renderSceneToOffscreen` on the offscreen). Never multiply CSS-px values by dpr in logic; use `getDevicePixelRatio()` (exported from draw.js) only where the bitmap size is set. See DESIGN.md §2.7.1.
- **SVG icons in the toolbar are inline** (`stroke="currentColor"`, 14×14). Button labels hidden visually — the verb lives in `title=` and in the action modal only.
- **Comments are detailed French explanations** of *why*, not *what*. Don't strip them — they're the project's design log.
- **LocalStorage keys** (all share `meshesDesigner.` namespace):
  - `meshesDesigner.consoleVisible` — bool
  - `meshesDesigner.consoleFrame` — JSON `{left,top,width,height}` in px for the log-overlay frame
  - `meshesDesigner.undo` — JSON `{ scene, historyStack, redoStack }` where `scene` is the exact `serializeState()` string written to `meshesDesigner.scene` at the same moment (fingerprint guard at boot)
  - `meshesDesigner.circleSegments` — int, nombre de côtés du cercle (préférence de session restaurée au boot, réglée à la molette en mode cercle)
  - `meshesDesigner.mergeDropRadius` — int, rayon en px écran de la fusion par déplacement (2e fonction de #mergePoints) : réglé à la molette sur le bouton quand le mode est armé, bornes 8–64 (défaut 20), restauré au boot par `restoreMergeDropRadius` (viewport.js), hors wire format
  - `meshesDesigner.colorPalette` — JSON array of hex `#rrggbb` strings (the fill is always derived from `(bg, colorAlpha)` via `triangleFillFromBg`; legacy keys storing `{bg}`/`{bg, alpha}` objects or plain strings are still read — per-swatch alpha is ignored, opacity is global). Editable/enrichable palette restored at boot by `restoreColorPalette` (editor.js), rewritten on every mutation. Preference: never marks the scene dirty, never serialized in exported files.
  - `meshesDesigner.colorAlpha` — float [0,1] working opacity of the `#colorAlpha` slider, the SINGLE opacity applied to every triangle paint (swatch click picks the color, opacity stays the user's). Persisted ONLY on manual slider drags (`persistColorAlpha`); swatch clicks / Escape / Reset / Défauts never overwrite the preference, so the user's last manual setting survives reloads and applies to painting (restored at boot inside `restoreColorPalette`, BEFORE the palette — its fills are derived from it). Same preference status: never marks the scene dirty, never serialized.
  - (scene + zoom + grid keys persisted too — search `localStorage` in `main.js` for the full list)
- **`#messageLog`** is the scrollable log region inside `#messageBoard`. Mutations go through it, never through `#messageBoard.innerText` (would destroy the drag handle / clear button).
- **Console overlay minimums:** `CONSOLE_MIN_WIDTH=80`, `CONSOLE_MIN_HEIGHT=30` — resize handler clamps to these.
- **Single editing mode:** the project exposes one `state.editingMode === 'edition'` since the construction + selection modes were merged into edition's fluent contract. The toolbar `#editMode` button + `E` shortcut were removed; `EDITING_MODES = ['edition']` and the silent `restoreEditingMode` in `viewport.js` are kept for backwards-compatible localStorage reads only — there is no toggle UI to persist anymore.
- **Mouse buttons:** `e.button === 0` is the canonical left-click gate used everywhere; middle-click on the canvas = pan; `getModifierState('AltGraph')` OR `(ctrlKey && altKey)` = AltGr detection (because AltGr is browser-inconsistent).

## Gotchas

- **Must serve via HTTP, not `file://`.** `convert.js` uses `FileReader` and the import drag-drop, both blocked by browser under `file://`. The README and the help modal both say so.
- **localStorage is sticky across reloads.** Scene, grid step, zoom, *and* console visibility + frame position persist. Clear it from devtools between tests for a clean slate.
- **`temp.json` is gitignored** — it's the browser's auto-download dump from `downloadMesh`; not part of the repo.
- **`main.js` mutates `messageBoard.innerText`** heavily (one of the slowest DOM APIs). Acceptable here because the log is small, but avoid the pattern elsewhere.
- **No unit tests / no lint.** The automated guards are `npm run check` (syntax + 6 smoke suites) and `npm run check:portable` (portable build + `file://` test), wired into CI. Treat visual verification in a browser as the primary test loop for new interactions.
- **Encoding:** meshes format uses `;` between vertices and `,` between coords; no locale, no units — raw floats.
- **AltGr rotation pivot tracks cursor** in model space; still anchored to the cursor at the first tick of the gesture, but recomputed if the cursor moves mid-gesture (search `pivotScreen` in `main.js`).
- **Undo/redo history** in `historyStack` / `redoStack` (capped at `MAX_HISTORY = 50`, oldest evicted). Call `updateUndoRedoHud()` after any mutation you make on those stacks — it syncs the `#undoCount` pill and the `disabled` attribute on the toolbar buttons. Keyboard shortcuts `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` and the toolbar `#undo` / `#redo` buttons share the same `undo()` / `redo()` functions (single source of truth). Both stacks persist to `meshesDesigner.undo` and are restored at boot by `loadState()` → `restoreUndoHistory()` (fingerprint `scene` must match the restored scene, else entries are discarded). Reinit points (memory + persisted): `resetAll()` and import REPLACE in `applyImport`; import MERGE KEEPS the stacks (`markUndoPersistDirty()` refreshes the fingerprint after the append). Whenever you mutate the stacks in a new code path, call `markUndoPersistDirty()` so the next `persistState()` rewrites the undo key.
