# Claude Pet

A free anime desktop pet that reacts to [Claude Code](https://claude.com/claude-code). She thinks while Claude thinks,
types while it works, waves when it needs you, celebrates when it finishes, and wanders around your screen: she climbs
the edges of your windows, jumps between them, sits on a window's edge, and falls if you drop her. Windows 10 and 11,
and NixOS (see below; fewer tricks there).

Claude Code's HTTP hooks POST each event to a tiny server on `127.0.0.1:47821`. Nothing about your Claude Code sessions
leaves your computer and no API key is involved. (The Characters window fetches the community catalog from this
repository on GitHub when you open it; that is the only network use.) This is an unofficial fan project, not affiliated
with or endorsed by Anthropic.

## Characters

Tray menu, **Characters…** (or just start the app a second time) opens the Characters window:

- **Base**: Sonnet, an original character who ships with the app (the default).
- **Community**: girls other people made, downloaded from the online catalog (the `catalog/` folder of this repository).
  **Kurumi** is the first: an unofficial, non-commercial fan redraw (an adult version) of Kurumi Tokisaki from *Date A
  Live*. The character belongs to her creators and rights holders; this project is not affiliated with them, and the art
  will be removed on request.
- **Mine**: girls you made with **New girl**, or imported from a pack file. **Export** saves a girl as a `.zip` you can
  send to a friend (they use **Import pack…**); **Share** exports her and opens a GitHub form to offer her to everyone.

## Download and install (Windows, 64-bit)

1. Get the latest zip from the **Releases** page of this repository and unzip it.
   (If SmartScreen complains: right-click the zip, Properties, tick Unblock, then unzip again.)
2. Double-click **Install Claude Pet.bat**. It asks whether to add shortcuts, start her with Windows, and add the
   Claude Code hooks (this is what makes her react; a backup of your settings is written first).
3. Start a new Claude Code session. She's on your desktop; right-click her or use the tray icon for the menu.

Nothing else needs installing: Electron is bundled. To try her without installing, run **Claude Pet.bat**. To remove
her: Start menu, "Uninstall Claude Pet".

## NixOS

```
nix run .                      # in a checkout, or: nix run github:<owner>/<repo>
```

or add `claude-pet.packages.${system}.default` to `environment.systemPackages` / `home.packages`, then run
`claude-pet`. Hooks install from the tray menu as on Windows.

- It runs on nixpkgs' Electron, forced onto X11 (XWayland on a Wayland session): Wayland does not let an app place a
  window or keep it on top. The transparent window needs a compositing session; GNOME needs the AppIndicator
  extension for the tray icon.
- Only she takes clicks: the overlay is cut to a box round her (and her confetti), because a Linux window can't
  forward the mouse while it is click-through. The empty corners of that box swallow clicks. If clicks stop reaching
  your other apps, quit her from the tray (or Ctrl+C) and report it. `PET_SHAPE=1 npm start` tries the same elsewhere.
- She climbs and stands on open X11 windows (`src/x11windows.c`, built by the flake). On a Wayland session that means
  only the XWayland ones: native Wayland windows are invisible to her, and Wayland has no way to list them.
- New girls are built with sharp, which the flake unpacks from the hashes in `package-lock.json` and patches to run on
  NixOS (`nix/sharp-deps.nix`, written by `node tools/nix-sharp.js`). Your girls live in `~/.config/claude-pet/characters`.
- Flakes only see files git tracks: `git add` new files before building, and commit `flake.lock` (`nix flake lock`).

## Make your own character

Characters window, **New girl**: drop her pictures in (name each file after its pose, like `idle.png` and `walk.png`, and
they place themselves; `idle` is required, `blink thinking working waiting happy thanks oops sleeping held fall jump sit
walk walk2 climb climb2` are optional; png, webp or jpg), type her name, press **Make her**. All pictures need the same
flat green background (or a transparent one), and she should be the same size and in the same spot in each. Walk, climb
and jump should face left. She is built in under a minute and put on your screen. More detail is in the sections below.

## License

The code is MIT (see `LICENSE`). The character artwork is not covered by it: Sonnet is all rights reserved, included so the
app runs out of the box, and Kurumi is fan art as described above. Third-party pieces: Electron (MIT), sharp (Apache-2.0)
and koffi (MIT).

---

# Developer notes

## Run

```
npm install
npm start
```

Right-click her or use the tray icon for size, wandering, window climbing, always-on-top, a preview menu and the hook installer.

## Hook up Claude Code

Tray menu → **Install Claude Code hooks…** (or `npm run hooks:install`). It adds HTTP hooks to
`~/.claude/settings.json`, keeps your other settings and writes a timestamped backup first.
`npm run hooks:status` shows what is installed, `npm run hooks:uninstall` removes only the pet's hooks.
Start a new Claude Code session afterwards. If the pet isn't running the hooks fail silently and never block a tool call.

| Claude Code event | She shows |
| --- | --- |
| `UserPromptSubmit` | thinking |
| `PreToolUse` / `PostToolUse` | working |
| `PermissionRequest` / `Notification` | waiting (waving) |
| approval granted | thanks, then working |
| `PostToolUseFailure` | oops |
| `Stop` | happy, peace sign and confetti |
| nothing for 5 minutes | sleeping |

If something doesn't react, `GET http://127.0.0.1:47821/events` lists the last hook events the pet received.

## Physics and roaming

- Pick her up with the mouse and she dangles from the spot you grabbed. Let go and she falls; fling her and she flies.
- She lands on the floor (top of the taskbar) or on the top edge of an open window, and rides the window if you move it.
  She can stand on a window whose top is so high that only about half of her is on screen.
- While Claude is idle she wanders, hurrying when she is heading for something. She climbs the screen edges and the
  sides of windows, leaps from the floor up onto a window (with a short run-up), and at the top of a climb prefers to
  jump to a window rather than let go. If you move, resize, minimise or close a window she is climbing, she falls off.
  Any Claude activity stops her where she is (if she is climbing she lets go and falls).
- She hides while something is fullscreen. Maximised windows count as the screen, not as something to stand on.
- `GET http://127.0.0.1:47821/actor` shows what she is doing and which windows she can see.

She is drawn on a canvas, pixel for pixel at whole-pixel positions, from frames pre-rendered at her exact size and at
a few slightly taller heights, all the same width (cached in the app's data folder). Breathing stretches her up only, by
blending neighbouring heights instead of scaling her: scaling made the browser switch image filtering at certain sizes
and her sharpness jumped. `PET_SHARP=1 npx electron .` measures her sharpness across the breath at all three sizes, and
checks that no copy of her is left behind (the "bulge").

## Art

Put one image per pose in `characters/<name>/raw/`, all on the same flat green background, then run `npm run art`.
It removes the green, lines the standing frames up, crops everything to one shared box and writes
`characters/<name>/frames/` plus `_contact-*.png` sheets to check the edges.

| Pose | File(s) | Notes |
| --- | --- | --- |
| standing | `idle blink thinking working waiting happy thanks oops sleeping` | same feet and head position in every frame |
| `held` | `held` | shown while she is picked up (stand-in: `oops`) |
| `fall` | `fall` | shown in the air (stand-in: `waiting`) |
| `jump` | `jump` | shown while she leaps between a wall, a window and the floor (stand-in: `waiting`) |
| `sit` | `sit` | she sits down now and then while idle, for 8–25s. The art step rescales it (`SCALES.sit` in `tools/process-art.js`, 0.89) so her head and body match the standing size, drops its lowest pixel onto idle's soles and centres it. Without this art she never sits |
| `walk` | `walk`, `walk2` | optional second frame; cycled while walking (stand-in: `idle` with a bob) |
| `climb` | `climb`, `climb2` | optional second frame; cycled while climbing (stand-in: `waiting`) |

Art for `walk`, `climb` and `jump` should face left; if yours faces right set `"motion": { "walk": { "facing": "right" } }`
in the manifest and she is mirrored to match her direction. A new character also needs a `manifest.json`
(copy `characters/sonnet/manifest.json`).

Poke her without Claude Code:

```
curl -X POST http://127.0.0.1:47821/debug -d "{\"state\":\"happy\",\"confetti\":true}"
```

## Adding a character by dropping in pictures

The Characters window's **New girl** does this for you; this is what happens under it. Only Sonnet ships in `characters/`
(a folder with `"base": true` in its manifest is a base girl). Downloaded and made girls live in the user folder
(`%APPDATA%\claude-pet\characters` on Windows, `~/.config/claude-pet/characters` on Linux; the Characters window's
footer opens it), which an update or reinstall never touches.
Make a folder there named after her, drop in images named like the poses in the table above (png, webp or jpg; only
`idle` is required; they can sit directly in the folder or in a `raw` subfolder) and she is built automatically within
seconds: the app watches the folder and runs `tools/process-art.js` in a separate process, which keys out the green,
lines the standing frames up, writes `frames/`, `_contact-*.png` and (unless you wrote your own) a `manifest.json` marked
`"auto"`, then offers her under Mine. `import-log.txt` in her folder says what happened. An `art.json` next to the images
(`{"scales": {"sit": 0.9}}`) resizes a pose. `npm run art -- <name or path>` runs the same tool by hand.
A standing pose whose legs are nothing like idle's (a jump for joy as `happy`) is spotted automatically: it is grounded
like `sit` and `jump`, and the manifest marks it `"hop": true`, so she bounces while it is shown.

How the art tool places the motion poses (the default; Sonnet uses `"legacy": true` in her art.json, which keeps her
frames exactly as they were): frames of different sizes are centred on one canvas; `held`, `fall`, `sit` and the mid-air
poses are scaled by matching idle's face over theirs (the log shows the scale and how well it matched; `"scales"` in
art.json overrides it, `"autoScale": false` turns it off); `held` and `fall` are placed so their face is exactly where
idle's face is; `sit`, `jump` and mid-air poses stand their lowest pixel on idle's soles; `walk` and `climb` are
lined up by their torso, because the pet mirrors them about idle's centre line. `"seat": 0.53` in art.json (how far down
the sit image her seat is, 0 to 1) makes her sit with her seat on the top edge of a window, legs hanging over it, and
only ever on window tops. Characters the tool built are sized so their idle body is as tall as Sonnet's at the same
size setting, however much headroom their frame has.

## The community catalog

The Community tab reads `catalog/index.json` from this repository's `main` branch (`src/catalog.js`; `PET_CATALOG=<url>`
points the app at another catalog, for testing). Each girl is a pack: a `.zip` with `manifest.json`, an optional
`art.json` and `frames/<pose>.png`, plus a preview picture. Nothing from the network is trusted: the index lists each
pack's sha256 and the app refuses a download that differs, only those file names are read, every frame must be a real
PNG, sizes are capped and nothing can be written outside her own folder (`src/charpack.js`, `src/zip.js`, tested).

To add a girl someone offered (the **Share** button opens a GitHub issue where they attach the `.zip`), check the art and
its rights, then:

```
npm run catalog -- add path\to\mia.zip --author "their name" --description "one line"
```

That validates the pack, writes `catalog/packs/mia.zip`, makes the preview and rebuilds `catalog/index.json`; commit and
push and she is live. `npm run catalog -- remove mia` takes her out; `npm run catalog -- build` rebuilds the index.

## Moving her to another PC

`npm run pack` builds `dist/Claude-Pet.zip` (about 160 MB): her code and frames, the Electron runtime, an installer
(`Install Claude Pet.bat`), an uninstaller, a no-install launcher (`Claude Pet.bat`) and a short README.txt. The target
PC needs nothing installed; `electron.exe` also runs the hook installer as plain node. The installer copies everything
to `%LOCALAPPDATA%\Claude Pet`, adds shortcuts, optionally starts her with Windows and optionally adds the Claude Code
hooks (with a backup). The scripts live in `installer/`. Tested here by installing, reinstalling over an existing
install and uninstalling against a fake user profile; not yet run on a second real PC.

## Tests

`npm test` runs the physics tests (landing, windows, riding, throwing, twenty simulated minutes of roaming), the
parser for the X11 window helper, and the character pack and zip tests (round trip, and every way a pack can be hostile).
