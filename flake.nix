{
  description = "Claude Pet: anime desktop pet that reacts to Claude Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
      sharpArch = { x86_64-linux = "x64"; aarch64-linux = "arm64"; };
    in {
      # Runs on nixpkgs' Electron: the npm one is a prebuilt binary NixOS can't execute. The app needs no npm packages on
      # Linux (koffi reads Windows windows only) except sharp, which builds a new girl's frames: its tarballs are unpacked
      # from the hashes in package-lock.json (nix/sharp-deps.nix) and patched to run here. The open windows come from a
      # small C helper built here.
      packages = forAll (system: pkgs:
        let
          sharp = import ./nix/sharp-deps.nix { inherit (pkgs) fetchurl; };
          unpackSharp = nixpkgs.lib.concatMapStrings (d: ''
            mkdir -p $app/node_modules/${d.name}
            tar xzf ${d.src} -C $app/node_modules/${d.name} --strip-components=1
          '') (sharp.common ++ sharp.${system});
        in rec {
          claude-pet = pkgs.stdenv.mkDerivation {
            pname = "claude-pet";
            version = "0.1.0";
            src = self;
            nativeBuildInputs = [ pkgs.makeWrapper pkgs.autoPatchelfHook ];
            buildInputs = [ (pkgs.libx11 or pkgs.xorg.libX11) pkgs.stdenv.cc.cc.lib ];
            buildPhase = ''
              $CC -O2 -Wall -o claude-pet-windows src/x11windows.c -lX11
            '';
            installPhase = ''
              app=$out/share/claude-pet
              mkdir -p $app
              cp -r package.json src tools characters $app/
              rm -rf $app/characters/*/raw   # source art for the art tool, not needed to run
              ${unpackSharp}
              # sharp's native module finds libvips next to it
              addAutoPatchelfSearchPath $app/node_modules/@img/sharp-libvips-linux-${sharpArch.${system}}/lib
              install -Dm755 claude-pet-windows $out/libexec/claude-pet-windows
              # X11 (XWayland on Wayland): Wayland won't let an app place a window or keep it on top
              makeWrapper ${pkgs.electron}/bin/electron $out/bin/claude-pet \
                --add-flags "--ozone-platform=x11" --add-flags "$app" \
                --set PET_X11_HELPER $out/libexec/claude-pet-windows
            '';
            meta.mainProgram = "claude-pet";
          };
          default = claude-pet;
        });

      apps = forAll (system: _: {
        default = { type = "app"; program = "${self.packages.${system}.claude-pet}/bin/claude-pet"; };
      });
    };
}
