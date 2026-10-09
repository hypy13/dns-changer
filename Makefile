UUID := dns-changer@hossein.dev
ZIP := $(UUID).shell-extension.zip

# This expression works both in Looking Glass and through org.gnome.Shell.Eval.
RESCAN_JS := (async () => { const uuid = "$(UUID)"; const Main = await import("resource:///org/gnome/shell/ui/main.js"); const Gio = (await import("gi://Gio")).default; const manager = Main.extensionManager; if (!manager.lookup(uuid)) { const dir = Gio.File.new_for_path(global.userdatadir + "/extensions/" + uuid); await manager.loadExtension(manager.createExtensionObject(uuid, dir, 2)); } return uuid; })()

.PHONY: pack install rescan enable demo clean

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
		printf 'Installed and re-enabled $(UUID). Restart GNOME Shell to load changed JavaScript (log out and back in on Wayland).\n'; \
	else \
		printf 'Installed. Enable it with: make enable\n'; \
	fi

rescan:
	@set -eu; \
	installed=$$(gnome-extensions list); \
	if printf '%s\n' "$$installed" | grep -Fxq '$(UUID)'; then \
		printf 'GNOME Shell already knows about $(UUID).\n'; \
		exit 0; \
	fi; \
	if result=$$(gdbus call --session --dest org.gnome.Shell \
		--object-path /org/gnome/Shell --method org.gnome.Shell.Eval \
		'$(RESCAN_JS)' 2>&1); then \
		case "$$result" in \
			"(true,"*) printf 'Registered $(UUID) in the running GNOME Shell.\n'; exit 0 ;; \
			"(false, '')") printf 'GNOME Shell blocks D-Bus evaluation outside unsafe mode.\n' ;; \
			*) printf 'GNOME Shell could not register the extension: %s\n' "$$result" ;; \
		esac; \
	else \
		printf 'Could not contact GNOME Shell: %s\n' "$$result"; \
	fi; \
	printf '\nPress Alt+F2, enter lg, and paste this one line into the evaluator:\n\n%s\n\nThen close Looking Glass and run: make enable\n' '$(RESCAN_JS)'; \
	exit 1

enable: rescan
	gnome-extensions enable '$(UUID)'

demo: pack
	sh scripts/demo.sh '$(UUID)' 'dist/$(ZIP)'

clean:
	rm -rf dist schemas/gschemas.compiled
