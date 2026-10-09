# Contributing to DNS Changer

Thanks for your interest in improving DNS Changer. This guide covers the project structure, local build and demo workflows, and the checks to include with a contribution.

DNS Changer is a GNOME Shell extension written in GJS using ES modules. It supports GNOME Shell 45–51, uses NetworkManager to update connection DNS settings, and stores extension preferences with GSettings.

## Project structure

- `extension.js` builds the top-panel menu, applies and restores DNS settings, and displays provider checks.
- `network.js` reads and updates NetworkManager profiles through `nmcli`, and runs DNS or ping probes.
- `prefs.js` builds the preferences window for custom DNS providers.
- `schemas/org.gnome.shell.extensions.dns-changer.gschema.xml` defines provider settings and saved profile backups.
- `metadata.json` defines the extension UUID, description, and supported GNOME Shell versions.
- `Makefile` contains the packaging, install, enable, demo, and cleanup commands.
- `scripts/demo.sh` starts an isolated nested GNOME Shell session for manual UI review.

## Requirements

For packaging and installing, you need `make`, `glib-compile-schemas`, and the `gnome-extensions` command. To try DNS changes, use a GNOME desktop with NetworkManager. DNS provider checks use `dig`; if it is unavailable, the extension can use `ping` as a network-latency approximation.

The nested demo requires a Wayland desktop session, `gnome-shell`, `dbus-run-session`, `gsettings`, and `unzip`. On GNOME 49 and later, the demo uses GNOME Shell's DevKit mode; some distributions package this separately as `mutter-devkit` (or `mutter-dev-bin` on Ubuntu).

## Build and run

### Package the extension

```sh
make pack
```

This compiles the GSettings schema and creates `dist/dns-changer@hossein.dev.shell-extension.zip`.

### Install in your user account

```sh
make install
```

If the extension was already enabled, this disables it during installation and enables it again afterward. If it was not enabled, including on a first install, enable it with:

```sh
make enable
```

`make enable` runs `make rescan` first so the running Shell can discover a newly installed extension. If GNOME blocks the D-Bus registration step, the command prints a line to paste into Looking Glass: press **Alt+F2**, enter `lg`, paste the line into the evaluator, close Looking Glass, then rerun `make enable`. `make rescan` can also be run by itself to register the extension without enabling it.

When changing JavaScript that GNOME Shell has already loaded, start a fresh GNOME session to load the updated code. On Wayland, log out and back in. Disabling and enabling the extension alone does not reload its imported JavaScript modules.

### Run the nested demo

```sh
make demo
```

Run this from a terminal in a Wayland session. It builds the current source and launches a nested GNOME Shell window with separate temporary extension files and settings. Close the demo window or press **Ctrl+C** to stop it; run `make demo` again after code changes to start a fresh Shell process.

The demo isolates Shell and extension settings, but DNS actions still apply to your real NetworkManager connections and restart NetworkManager. Do not select or restore a provider in the demo unless you intend to change the host connection.

### Remove generated files

```sh
make clean
```

This removes the generated `dist/` directory and compiled schema file.

## Development notes

- Keep GNOME Shell UI setup and signal connections in the extension lifecycle. Clean up actors, signals, timers, and cancellable operations when the extension is disabled.
- Keep NetworkManager and DNS-probe command handling in `network.js`; keep provider preferences in `prefs.js` and settings definitions in the schema.
- The extension uses ES modules and asynchronous command handling. Avoid blocking the Shell's UI thread while waiting for system commands or DNS probes.
- Wrap user-visible strings with gettext's `_()` helper so they remain ready for translation.
- Preserve existing user settings when changing schema defaults or provider handling.
- Update this guide or the [user-facing README](README.md) when a contribution changes build steps or user-visible behavior.

## Validation and pull requests

There is no automated test target in the repository yet. Before opening a pull request, run `make pack` to check that the schema compiles and the extension packages. For UI changes, use `make demo` and describe the GNOME Shell version and manual checks you performed. Review NetworkManager changes carefully, since applying or restoring DNS restarts the host's NetworkManager service.

Keep pull requests focused and include a short description of the change, its user impact, and how you validated it. For broader GNOME extension review guidance, see the [GNOME review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html).
