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

## Accounts and the class gallery

When the site runs with its server (see below) three extra buttons appear:

- **👤 Sign in / your name** — create an account with a username and password (no email, no real name). Shows *My dioramas* and your gallery settings.
- **☁️ Save online** — save the diorama to your account. Choose *Only me* or *In my gallery*, and optionally require a **code** to open that diorama.
- **🖼️ Gallery** — look at dioramas other signed-in people shared. A person can protect their whole gallery with a **gallery code**. While looking at someone else's diorama, 🚩 **Report** sends it to the admin.

The live site is https://blockscape.onrender.com. If the files are ever served without the server (for example `python3 -m http.server`), these buttons stay hidden and everything else (building, pictures, share links, files) still works.

### Admin (done in Neon, no in-app admin page)

Open the Neon SQL editor for the project:

```sql
-- make someone an admin (admins can open and delete any diorama in the app)
UPDATE users SET is_admin = TRUE WHERE username = 'their_username';

-- see reports
SELECT r.id, r.reason, r.created_at, d.id AS diorama_id, d.title, o.username AS owner, p.username AS reporter
FROM reports r JOIN dioramas d ON d.id = r.diorama_id
JOIN users o ON o.id = d.owner_id JOIN users p ON p.id = r.reporter_id
ORDER BY r.created_at DESC;

-- remove a diorama (its reports go with it)
DELETE FROM dioramas WHERE id = 123;

-- remove a user and everything they made
DELETE FROM users WHERE username = 'someone';
```

There is no password reset (no email). A forgotten password means deleting the account and signing up again.

## Running the server

```bash
npm install
# .env (never commit it) must contain the Neon pooled connection string:
#   DATABASE_URL_POOLED="postgresql://...-pooler...neon.tech/neondb?sslmode=require"
npm start                  # http://localhost:3000
```

Tables are created automatically on start. Deploying on Render: connect this repo, use `render.yaml`, and add `DATABASE_URL_POOLED` as a secret environment variable. The server never queries the database unless someone signs in or uses accounts, so Neon can scale to zero when nobody is around.

Without a server you can still preview the editor: `python3 -m http.server 8000`. (Opening `index.html` straight from disk won't work, because browsers block ES modules on `file://`.)

## Tests

```bash
npm test                      # world logic + the account server (uses throw-away zz_test_ tables in the database from .env)
```

## Layout

| File | What it is |
| --- | --- |
| `src/world.js` | The voxel grid, undo history, ray casting and save format (no DOM) |
| `src/blocks.js`, `src/textures.js` | The 28 blocks and their pixel-art textures (drawn with canvas) |
| `src/view.js` | The Three.js scene: lights, shadows, stand, signs, camera |
| `src/main.js` | Tools, palette, dialogs, picture export, sharing |
| `src/account.js`, `src/api.js` | Sign in, save online, gallery, codes, reports (browser side) |
| `server/` | Express server: accounts, sessions, saved dioramas, gallery, reports (Postgres on Neon) |
| `vendor/` | Three.js r186 and OrbitControls (MIT licence), vendored so the site works offline |
