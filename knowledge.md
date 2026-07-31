# Project knowledge

This file gives Freebuff context about this project: goals, commands, conventions, and gotchas. See `README.md` for the full user-facing docs (UI legend, shortcut table, file formats).

## What this is

**Vanilla-JS 2D mesh editor** — draw points, build triangles, save/load scenes as JSON or a custom « meshes » text format. **Zero dependencies, zero build step, zero framework.** Single page app served as static files.

The whole UI is one HTML page driving a `<canvas>`; HTML/CSS/JS are not transpiled.

## Quickstart

- **Setup:** none (no `npm install`, no `package.json`).
- **Dev:** `python3 test_server.py` from the project root → serves on `http://localhost:8000/`, then open `main.html`. The script does a real bind-check (port + connect-back probe) and exits with an error if the port is taken.
- **Test:** none. Syntax check only: `node --check main.js && node --check draw.js && node --check convert.js`.
- **Lint / build:** none.
- **Headless import test:** `http://localhost:8000/main.html?autoimport=<base64-urlsafe-text>` triggers an auto-import of a meshes-formatted string (no file picker needed).

## Architecture

Four source files + one Python dev server, plus assets:

| File | Rôle |
|---|---|
| `main.html` | Layout, CSS (toolbar, HUD, modales), declares the toolbar buttons + help modal + log overlay (`#messageBoard` with drag handle + SE resize grip). Mounts the JS. |
| `main.js` | App logic: state (`ctx`, `shapes`, selection, zoom, pan, undo/redo), mouse/keyboard events, drawing, persistence, import/export. |
| `draw.js` | Pure render primitives (points, lines, triangles, axes, grid). All coords go through `modelToScreen()`. |
| `convert.js` | Parser: meshes-format text ↔ multi-shape JSON scene. Reads files via `FileReader` (this is why HTTP serving is mandatory). |
| `test_server.py` | Threaded `http.server` on port 8000 with EADDRINUSE-diagnostics. |
| `assets/` | `barre_boutons.png` (toolbar screenshot), `meshes-sample`, `mesh-1785093938339.json`, `alphabet2` (legacy example). |

Data flow: `main.js` owns app state → calls render primitives in `draw.js` (post-transformation via `modelToScreen`) → user input updates state → main persists via `localStorage`.

## Conventions

- **No build / no transpile / no bundler.** Edits + browser reload = iteration. No HMR.
- **Y axis inverted.** `modelToScreen` flips Y so larger `model.y` renders higher on canvas (math-style). Mind this when touching pan or rotation math.
- **`ctx` shape:** `{ center: {x,y}, viewCenter: {x,y}, zoomLevel: number }`. `center` is pixel position of model origin on canvas; `viewCenter` is which model point is centered; `zoomLevel` is a multiplier (clamp `[0.1, 10]`).
- **SVG icons in the toolbar are inline** (`stroke="currentColor"`, 14×14). Button labels hidden visually — the verb lives in `title=` and in the action modal only.
- **Comments are detailed French explanations** of *why*, not *what*. Don't strip them — they're the project's design log.
- **LocalStorage keys** (all share `meshesDesigner.` namespace):
  - `meshesDesigner.consoleVisible` — bool
  - `meshesDesigner.consoleFrame` — JSON `{left,top,width,height}` in px for the log-overlay frame
  - (scene + zoom + grid keys persisted too — search `localStorage` in `main.js` for the full list)
- **`#messageLog`** is the scrollable log region inside `#messageBoard`. Mutations go through it, never through `#messageBoard.innerText` (would destroy the drag handle / clear button).
- **Console overlay minimums:** `CONSOLE_MIN_WIDTH=80`, `CONSOLE_MIN_HEIGHT=30` — resize handler clamps to these.
- **Mouse buttons:** `e.button === 0` is the canonical left-click gate used everywhere; middle-click on the canvas = pan; `getModifierState('AltGraph')` OR `(ctrlKey && altKey)` = AltGr detection (because AltGr is browser-inconsistent).

## Gotchas

- **Must serve via HTTP, not `file://`.** `convert.js` uses `FileReader` and the import drag-drop, both blocked by browser under `file://`. The README and the help modal both say so.
- **localStorage is sticky across reloads.** Scene, grid step, zoom, *and* console visibility + frame position persist. Clear it from devtools between tests for a clean slate.
- **`temp.json` is gitignored** — it's the browser's auto-download dump from `downloadMesh`; not part of the repo.
- **`main.js` mutates `messageBoard.innerText`** heavily (one of the slowest DOM APIs). Acceptable here because the log is small, but avoid the pattern elsewhere.
- **No tests / no lint.** The only automated guard is `node --check`. Treat visual verification in a browser as the test loop.
- **Encoding:** meshes format uses `;` between vertices and `,` between coords; no locale, no units — raw floats.
- **AltGr rotation pivot tracks cursor** in model space; still anchored to the cursor at the first tick of the gesture, but recomputed if the cursor moves mid-gesture (search `pivotScreen` in `main.js`).
- **Undo/redo history** in `historyStack` / `redoStack` (capped at `MAX_HISTORY = 50`, oldest evicted). Call `updateUndoRedoHud()` after any mutation you make on those stacks — it syncs the `#undoCount` pill and the `disabled` attribute on the toolbar buttons. Keyboard shortcuts `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` and the toolbar `#undo` / `#redo` buttons share the same `undo()` / `redo()` functions (single source of truth).
