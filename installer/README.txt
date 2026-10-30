CLAUDE PET - Sonnet 5.5
=======================

An anime desktop pet that reacts to Claude Code. She thinks while Claude thinks, types while it works,
waves when it needs you, celebrates when it finishes, and wanders around your screen, climbing windows.

Needs: Windows 10 or 11, 64-bit. Nothing else: Electron is included, you do not need Node.js.


INSTALL
-------
1. Unzip the whole archive somewhere (right-click the zip > Extract All).
   Tip: if Windows SmartScreen complains, right-click the zip > Properties > tick "Unblock" > OK,
   and unzip again. Or click "More info" > "Run anyway" on the warning.
2. Double-click  "Install Claude Pet.bat"  and answer the questions:
     - desktop and Start menu shortcuts
     - start with Windows (optional)
     - add the Claude Code hooks (this is what makes her react to Claude)
     - start her now
   It installs to  %LOCALAPPDATA%\Claude Pet  and does not need administrator rights.
   You can delete the unzipped folder afterwards.

No install, just try her:  double-click  "Claude Pet.bat"  (runs from the unzipped folder).


USING HER
---------
Right-click her or use the tray icon: size, wandering, window climbing, always on top, previews,
installing or removing the Claude Code hooks, Quit.
Pick her up with the mouse and drop or throw her. While Claude is working she stays put and reacts.

Claude Code hooks: the installer adds HTTP hooks to  %USERPROFILE%\.claude\settings.json  (a backup is
written first and your other settings are kept). They only talk to 127.0.0.1:47821, on your own PC.
If she is not running they fail silently and never slow Claude down. Start a new Claude Code session
after installing them. If she does not react, open  http://127.0.0.1:47821/events  in a browser to see
whether events arrive.


CHARACTERS
----------
Tray menu > Characters... opens the Characters window (so does starting Claude Pet a second time).
  Base       Sonnet, who comes with the app.
  Community  girls other people made, downloaded from the online catalog (needs internet).
  Library    your own. "Add": drop her pictures in (name each file after its pose: idle, blink, thinking,
             working, waiting, happy, thanks, oops, sleeping, held, fall, jump, sit, walk, walk2, climb, climb2;
             only idle is required), type her name, press "Create". Pictures need the same flat green
             background (or a transparent one). Export sends her to a friend as a .zip; Share offers her to everyone.
Your girls live in  %APPDATA%\claude-pet\characters, outside the install folder, so reinstalling, updating or
uninstalling never touches them.


UNINSTALL
---------
Start menu > "Uninstall Claude Pet" (or double-click "Uninstall Claude Pet.bat" in the install folder).
It removes the hooks she added, the shortcuts and the files, and asks whether to delete her saved settings.


FILES
-----
  app\        her code and art
  electron\   the Electron runtime
  setup\      the install and uninstall scripts (plain PowerShell, open them to see what they do)
Her settings and cached images live in  %APPDATA%\claude-pet.
