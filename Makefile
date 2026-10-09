UUID := dns-changer@hossein.dev
ZIP := $(UUID).shell-extension.zip

.PHONY: pack install enable clean

pack:
	glib-compile-schemas schemas
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist --extra-source=network.js --extra-source=LICENSE

install: pack
	@set -eu; \
	was_enabled=0; \
	if gnome-extensions list --enabled | grep -Fxq '$(UUID)'; then \
		was_enabled=1; \
		gnome-extensions disable '$(UUID)'; \
	fi; \
	gnome-extensions install --force 'dist/$(ZIP)'; \
	if [ "$$was_enabled" -eq 1 ]; then \
		gnome-extensions enable '$(UUID)'; \
		printf 'Installed and reloaded $(UUID) in the current GNOME session.\n'; \
	else \
		printf 'Installed. Enable it with: make enable\n'; \
	fi

enable:
	gnome-extensions enable $(UUID)

clean:
	rm -rf dist schemas/gschemas.compiled
