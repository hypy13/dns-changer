import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function parseProviders(settings) {
    return settings.get_strv('dns-providers').flatMap(entry => {
        try {
            const provider = JSON.parse(entry);
            if (provider.id && provider.name && Array.isArray(provider.ipv4) && Array.isArray(provider.ipv6))
                return [provider];
        } catch (error) {
            console.warn(`DNS Changer preferences: ignoring invalid provider: ${error.message}`);
        }

        return [];
    });
}

function parseAddresses(text, family, fieldName) {
    const addresses = text.trim().split(/[\s,;]+/).filter(Boolean);
    for (const address of addresses) {
        const parsed = Gio.InetAddress.new_from_string(address);
        if (!parsed || parsed.get_family() !== family)
            throw new Error(_('%s contains an invalid address: %s').replace('%s', fieldName).replace('%s', address));
    }
    return addresses;
}

export default class DnsChangerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._providerRows = new Map();

        const page = new Adw.PreferencesPage({
            title: _('DNS Providers'),
            icon_name: 'preferences-system-network-symbolic',
        });
        const providersGroup = new Adw.PreferencesGroup({
            title: _('DNS providers'),
            description: _('Choose a provider from the panel menu. Custom servers are stored in your user settings.'),
        });
        page.add(providersGroup);
        this._providersGroup = providersGroup;

        for (const provider of parseProviders(this._settings))
            this._appendProviderRow(provider);

        const formGroup = new Adw.PreferencesGroup({
            title: _('Add a custom provider'),
            description: _('Enter comma-separated server addresses and optional provider features. At least one IPv4 or IPv6 address is required.'),
        });
        page.add(formGroup);

        this._nameEntry = new Adw.EntryRow({title: _('Provider name')});
        this._ipv4Entry = new Adw.EntryRow({title: _('IPv4 DNS servers')});
        this._ipv6Entry = new Adw.EntryRow({title: _('IPv6 DNS servers')});
        this._featuresEntry = new Adw.EntryRow({title: _('Features (optional)')});
        formGroup.add(this._nameEntry);
        formGroup.add(this._ipv4Entry);
        formGroup.add(this._ipv6Entry);
        formGroup.add(this._featuresEntry);

        this._statusRow = new Adw.ActionRow();
        this._statusRow.visible = false;
        formGroup.add(this._statusRow);

        const addRow = new Adw.ActionRow({title: _('Add DNS provider')});
        const addButton = new Gtk.Button({
            label: _('Add'),
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => this._addProvider());
        addRow.add_suffix(addButton);
        formGroup.add(addRow);

        window.add(page);
        window.connect('close-request', () => {
            this._settings = null;
            this._providerRows = null;
            this._providersGroup = null;
            this._nameEntry = null;
            this._ipv4Entry = null;
            this._ipv6Entry = null;
            this._featuresEntry = null;
            this._statusRow = null;
            return false;
        });
    }

    _appendProviderRow(provider) {
        const ipv4 = provider.ipv4.join(', ') || _('none');
        const ipv6 = provider.ipv6.join(', ') || _('none');
        const features = Array.isArray(provider.features)
            ? provider.features.filter(Boolean).join(' · ')
            : '';
        const row = new Adw.ActionRow({
            title: provider.name,
            subtitle: `IPv4: ${ipv4} · IPv6: ${ipv6}` +
                (features ? ` · ${_('Features')}: ${features}` : ''),
        });

        if (provider.custom) {
            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove provider'),
                valign: Gtk.Align.CENTER,
            });
            removeButton.connect('clicked', () => this._removeProvider(provider.id));
            row.add_suffix(removeButton);
        }

        this._providersGroup.add(row);
        this._providerRows.set(provider.id, row);
    }

    _setStatus(title, message) {
        this._statusRow.title = title;
        this._statusRow.subtitle = message;
        this._statusRow.visible = Boolean(title || message);
    }

    _addProvider() {
        try {
            const name = this._nameEntry.text.trim();
            if (!name)
                throw new Error(_('Enter a provider name.'));

            const providers = parseProviders(this._settings);
            if (providers.some(provider => provider.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
                throw new Error(_('A provider with this name already exists.'));

            const ipv4 = parseAddresses(this._ipv4Entry.text, Gio.SocketFamily.IPV4, _('IPv4 DNS servers'));
            const ipv6 = parseAddresses(this._ipv6Entry.text, Gio.SocketFamily.IPV6, _('IPv6 DNS servers'));
            if (ipv4.length === 0 && ipv6.length === 0)
                throw new Error(_('Enter at least one IPv4 or IPv6 address.'));

            const provider = {
                id: `custom-${GLib.uuid_string_random()}`,
                name,
                ipv4,
                ipv6,
                features: this._featuresEntry.text.split(/[;,·]/)
                    .map(feature => feature.trim())
                    .filter(Boolean),
                custom: true,
            };
            providers.push(provider);
            this._settings.set_strv('dns-providers', providers.map(provider => JSON.stringify(provider)));
            this._appendProviderRow(provider);
            this._nameEntry.text = '';
            this._ipv4Entry.text = '';
            this._ipv6Entry.text = '';
            this._featuresEntry.text = '';
            this._setStatus('', '');
        } catch (error) {
            this._setStatus(_('Could not add provider'), error.message);
        }
    }

    _removeProvider(id) {
        const providers = parseProviders(this._settings).filter(provider => provider.id !== id);
        this._settings.set_strv('dns-providers', providers.map(provider => JSON.stringify(provider)));

        const row = this._providerRows.get(id);
        if (row)
            this._providersGroup.remove(row);
        this._providerRows.delete(id);
        this._setStatus('', '');
    }
}
