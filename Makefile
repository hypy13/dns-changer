UUID := dns-changer@hossein.dev
ZIP := $(UUID).shell-extension.zip

.PHONY: pack install clean

pack:
	glib-compile-schemas schemas
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist

install: pack
	gnome-extensions install --force dist/$(ZIP)

clean:
	rm -rf dist schemas/gschemas.compiled
