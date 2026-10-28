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


ADD ANOTHER CHARACTER
---------------------
Tray menu > Character > "Add a character (open the folder)". Make a folder there named after her and drop her
pictures in, one per pose, named idle, blink, thinking, working, waiting, happy, thanks, oops, sleeping, held, fall,
jump, sit, walk, walk2, climb, climb2 (png, webp or jpg; only idle is required). All pictures need the same flat
green background. After a few seconds she is built automatically and offered in the Character menu.
The folder is  app\characters  inside the install folder (%LOCALAPPDATA%\Claude Pet\app\characters, or the unzipped
folder if you run her without installing) and it has a README.txt with the same instructions.
Reinstalling keeps the characters you added. Uninstalling offers to copy them to your Documents folder first.


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
