UUID := dns-changer@hossein.dev
ZIP := $(UUID).shell-extension.zip

.PHONY: pack install enable clean

pack:
	glib-compile-schemas schemas
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist --extra-source=network.js

install: pack
	gnome-extensions install --force dist/$(ZIP)
	@printf 'Installed. Log out and back in, then run: gnome-extensions enable $(UUID)\n'

enable:
	gnome-extensions enable $(UUID)
	gnome-extensions enable $(UUID)

clean:
	rm -rf dist schemas/gschemas.compiled
