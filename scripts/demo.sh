#!/bin/sh
set -eu

uuid=$1
bundle=$2

for tool in gnome-shell dbus-run-session gsettings glib-compile-schemas unzip; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        printf 'make demo requires %s.\n' "$tool" >&2
        exit 1
    fi
done

if [ -z "${WAYLAND_DISPLAY:-}" ]; then
    printf 'Run make demo from a terminal in a Wayland desktop session.\n' >&2
    exit 1
fi

shell_help=$(gnome-shell --help)
case "$shell_help" in
    *--devkit*) nested_option=--devkit ;;
    *--nested*) nested_option=--nested ;;
    *) printf 'This GNOME Shell does not support a nested demo session.\n' >&2; exit 1 ;;
esac

demo_dir=$(mktemp -d "${TMPDIR:-/tmp}/dns-changer-demo.XXXXXX")
trap 'rm -rf "$demo_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export XDG_DATA_HOME="$demo_dir/data"
export XDG_CONFIG_HOME="$demo_dir/config"
export XDG_CACHE_HOME="$demo_dir/cache"
# Share settings between demo processes without using the desktop's dconf DB.
export GSETTINGS_BACKEND=keyfile
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"

extension_dir="$XDG_DATA_HOME/gnome-shell/extensions/$uuid"
mkdir -p "$extension_dir"
unzip -q "$bundle" -d "$extension_dir"
glib-compile-schemas "$extension_dir/schemas"

printf 'Starting a nested GNOME Shell with the current %s code enabled.\n' "$uuid"
printf 'Close the demo window or press Ctrl+C to stop. Rerun make demo after code changes.\n'
dbus-run-session -- sh -eu -c '
    gsettings set org.gnome.shell enabled-extensions "[\"$1\"]"
    gsettings set org.gnome.shell disable-user-extensions false
    exec gnome-shell "$2" --wayland --mode=user
' sh "$uuid" "$nested_option"
