# TokenTracker Linux Client

A Tauri desktop client for TokenTracker. It is the Linux counterpart of the macOS
menu bar app and the Windows tray app: a native shell that starts the bundled
TokenTracker CLI on a loopback port, loads the same dashboard in a WebKitGTK
window, and keeps a tray icon alive.

Two distribution paths are supported:

- **AppImage** — the released artifact, built by CI. Self-contained (it carries
  its own Node runtime and the built dashboard) and runs on any reasonably
  current glibc distro without a package manager.
- **Arch package** — a `PKGBUILD` for building from a local checkout.

## Install (AppImage)

Download `TokenTracker-linux-x86_64.AppImage` from the
[latest release](https://github.com/mohui666/TokenTracker/releases/latest),
then:

```bash
chmod +x TokenTracker-linux-x86_64.AppImage
./TokenTracker-linux-x86_64.AppImage
```

AppImages need FUSE. On distros that ship FUSE 3 only, install `fuse3`
(Debian/Ubuntu: `sudo apt install libfuse2t64` for older AppImage runtimes). To
run without FUSE at all:

```bash
./TokenTracker-linux-x86_64.AppImage --appimage-extract
./squashfs-root/AppRun
```

## Build the Arch package

```bash
cd TokenTrackerLinux/packaging/arch/tokentracker-linux
makepkg -si
```

> **Packaging scope:** this PKGBUILD builds from a local repository checkout. It
> is not ready for AUR publication or clean-chroot builds, and does not promise
> byte-identical artifacts.

Uninstall with `sudo pacman -R tokentracker-linux`.

## Run

Start **TokenTracker** from your application launcher, or run
`tokentracker-linux` (Arch package) / the AppImage directly.

On launch the window shows a loading screen while the bundled server starts, then
navigates to the dashboard. If the runtime cannot be found the window reports the
error and lists every location it checked, rather than hanging on the splash.

## Window and tray behaviour

- Closing the window hides it to the tray; the app keeps syncing in the
  background.
- Tray **Open Dashboard** restores the window.
- Tray **Quit** stops the bundled Node server and exits.

### The tray menu is the only tray interaction

Left-clicking the tray icon does **not** raise the window, and this is a platform
limitation rather than a bug. Linux tray icons go through
libayatana-appindicator, whose backend in the `tray-icon` crate never emits click
events — both Tauri and `tray-icon` document it as *"Linux: Unsupported. The
event is not emitted even though the icon is shown."* libappindicator opens the
menu on left click anyway, so **Open Dashboard** is the first menu item.

### GNOME does not show tray icons by default

GNOME removed StatusNotifierItem support, so on stock GNOME (including Ubuntu's
default session) **the tray icon will not appear at all**. Install the
[AppIndicator and KStatusNotifierItem Support](https://extensions.gnome.org/extension/615/appindicator-support/)
extension:

```bash
# Debian / Ubuntu
sudo apt install gnome-shell-extension-appindicator
# Fedora
sudo dnf install gnome-shell-extension-appindicator
```

Then enable it (GNOME Extensions app) and log out and back in. KDE Plasma, XFCE,
Cinnamon and MATE show the icon with no extra setup.

Until the extension is installed, closing the window hides the app with no way to
get it back from the tray — quit it from the launcher or with `pkill
tokentracker-linux`.

### The window is blank, or the app exits immediately

WebKitGTK renders through DMA-BUF by default. On some Wayland setups — most
reliably NVIDIA's proprietary driver — that path either paints a permanently
blank webview or loses the Wayland connection outright, exiting non-zero with:

```
Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.
```

The client therefore sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before starting
GTK. To retry the accelerated renderer, set it explicitly — an explicit value is
never overridden:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=0 tokentracker-linux
```

WebKitGTK treats the variable as "set and not `0`", so `=0` genuinely restores
the accelerated path while any other value (including an empty string) disables
it.

Note that when the webview aborts this way the app never reaches its shutdown
path, so the bundled Node server is left running and keeps port 17680. A later launch may fail to bind the preferred port until the orphan is stopped:

```bash
pkill -f 'tokentracker/bin/tracker.js serve'
```

## Logs

The bundled server's stderr goes to
`${XDG_STATE_HOME:-$HOME/.local/state}/tokentracker/server.log`, falling back to
`/tmp/tokentracker-server.log`. The log rotates once it passes 5 MB, keeping a
single `server.log.1` generation.

## Development

```bash
npm ci --prefix TokenTrackerLinux
npm run dashboard:build                        # from the repo root
npm --prefix TokenTrackerLinux run bundle:node # stages EmbeddedServer/
npm --prefix TokenTrackerLinux run dev
```

`bundle:node` must run before any bundling build: `tauri.bundle.conf.json`
declares `EmbeddedServer` as a bundle resource and `tauri-build` fails on a
missing resource path.

Tests:

```bash
cd TokenTrackerLinux/src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
```

Build dependencies: `webkit2gtk-4.1`, `gtk3`, `libayatana-appindicator`,
`librsvg`, `pkgconf` (plus the `-dev`/`-devel` packages on Debian/Fedora).
