# Blockscape

Build block dioramas in your browser — no install, no account. Place blocks, add text signs, switch between day, sunset and night, then **download a picture (PNG)** with a title bar or **copy a link** so others can walk around your scene.

Made for projects like "illustrate your favourite scene from a story".

## Using it

- **Look around:** drag to rotate, scroll or pinch to zoom, right-drag (or two fingers) to move.
- **Place a block:** pick one at the bottom, then click the ground or another block.
- **Remove a block:** right-click it, or hold Shift and click.
- **Tools:** 🧱 Build · 🧽 Erase · 📦 Box (click two corners to fill an area, Shift on the second click clears it) · 👆 Pick (copy a block) · 🏷️ Sign (floating text).
- **Undo / redo:** Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z.
- **Keys:** `1`–`9` pick blocks, `B` build, `E` erase, `X` box, `I` pick, `T` sign, `R` spin.
- **Save / share:** 📸 Picture (PNG with an optional title and caption), 🔗 Share link (the whole scene is inside the link), 💾 Save / 📂 Open (a `.blockscape` file). Your diorama also saves itself in the browser.

## Run it locally

It is a static site. Any web server works:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

(Opening `index.html` straight from disk will not work, because browsers block ES modules on `file://`.)

## Tests

```bash
node test/world.test.mjs      # world logic: edits, undo, ray casting, save format
```

## Layout

| File | What it is |
| --- | --- |
| `src/world.js` | The voxel grid, undo history, ray casting and save format (no DOM) |
| `src/blocks.js`, `src/textures.js` | The 28 blocks and their pixel-art textures (drawn with canvas) |
| `src/view.js` | The Three.js scene: lights, shadows, stand, signs, camera |
| `src/main.js` | Tools, palette, dialogs, picture export, sharing |
| `vendor/` | Three.js r186 and OrbitControls (MIT licence), vendored so the site works offline |
