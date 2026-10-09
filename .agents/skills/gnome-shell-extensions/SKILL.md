---
name: gnome-shell-extensions
description: Detailed guide for developing GNOME Shell Extensions using GJS (GNOME JavaScript).
---

# GNOME Shell Extensions

GNOME Shell Extensions are written in **GJS**, which are JavaScript bindings for the GNOME Platform APIs. They allow you to modify the behavior and appearance of the GNOME Shell.

## GNOME Shell Architecture

- **Clutter & St**: GNOME Shell is built on Clutter (abstract toolkit) and St (Shell Toolkit).
  - Users actors (widgets) like `St.Icon`, `St.Button`, etc.
  - Supports CSS styling.
- **Mutter**: The compositor/window manager. Access via `Meta` import for windows, displays, and workspaces.
- **Shell**: Provides utility classes and the `global` object.

## Getting Started

### Using the GNOME Extensions Tool

The easiest way to start is using the interactive CLI tool:

```bash
gnome-extensions create --interactive
```
Follow the prompts for Name, Description, and UUID (e.g., `my-extension@example.com`).

### Manual Creation

Extensions reside in `~/.local/share/gnome-shell/extensions/<uuid>/`.

Two files are **required**:
1. `metadata.json`: Defines information about the extension.
2. `extension.js`: Contains the logic.

#### `metadata.json` Example
```json
{
  "uuid": "example@gjs.guide",
  "name": "Example Extension",
  "description": "An example extension",
  "shell-version": ["45"],
  "url": "https://gjs.guide/extensions"
}
```

#### `extension.js` Example (GNOME 45+)
```javascript
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import St from 'gi://St';

export default class ExampleExtension extends Extension {
    enable() {
        // Create an indicator in the top bar
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        const icon = new St.Icon({
            icon_name: 'face-laugh-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
```

## Extension Lifecycle

- **`constructor(metadata)`**: Called when loaded. Setup translations or one-time data here. **Do not** touch the Shell UI here.
- **`enable()`**: Called when the extension is toggled on. Setup UI, connect signals, and modify behavior here.
- **`disable()`**: Called when the extension is toggled off or the Shell locks. **MUST** undo everything done in `enable()`.

## Testing (Wayland)

You can run a nested GNOME Shell session to test your extension without logging out.

1. **Start Nested Session**:
   ```bash
   # GNOME 49+
   dbus-run-session gnome-shell --devkit --wayland

   # GNOME 48 and earlier
   dbus-run-session gnome-shell --nested --wayland
   ```

2. **Enable Extension** (in a terminal within the nested session):
   ```bash
   gnome-extensions enable example@gjs.guide
   ```

## Best Practices

- **Performance**: Minimize heavy operations in the main thread.
- **Cleanup**: Always destroy actors and disconnect signals in `disable()`.
- **ES Modules**: GNOME 45+ uses native ESM (`import/export`).
- **Review Guidelines**: Ensure your code is clean and follows the [GNOME Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html).

## Resources
- [GJS Guide: Extensions](https://gjs.guide/extensions/)
- [GNOME Shell API Documentation](https://gjs-docs.gnome.org/)
