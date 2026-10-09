import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {
    detectProbeMode,
    getActiveConnection,
    probeServer,
    readProfileDns,
    reloadConnection,
    updateProfileDns,
} from './network.js';

function loadProviders(settings) {
    return settings.get_strv('dns-providers').flatMap(entry => {
        try {
            const provider = JSON.parse(entry);
            if (provider.id && provider.name &&
                Array.isArray(provider.ipv4) && Array.isArray(provider.ipv6) &&
                (provider.ipv4.length || provider.ipv6.length)) {
                return [provider];
            }
        } catch (error) {
            console.warn(`DNS Changer: ignoring invalid provider entry: ${error.message}`);
        }

        return [];
    });
}

function readBackups(settings) {
    const backups = new Map();
    for (const entry of settings.get_strv('profile-backups')) {
        try {
            const backup = JSON.parse(entry);
            if (backup.uuid)
                backups.set(backup.uuid, backup);
        } catch (error) {
            console.warn(`DNS Changer: ignoring invalid profile backup: ${error.message}`);
        }
    }
    return backups;
}

function saveBackups(settings, backups) {
    settings.set_strv('profile-backups', [...backups.values()].map(backup => JSON.stringify(backup)));
}

function storedDnsToServers(value) {
    return value.split(/[,;\s]+/).filter(Boolean);
}

function providerDns(provider) {
    return {
        ipv4DnsServers: provider.ipv4,
        ipv6DnsServers: provider.ipv6,
        ipv4IgnoreAutoDns: 'yes',
        ipv6IgnoreAutoDns: 'yes',
    };
}

function backupToDns(backup) {
    return {
        ipv4DnsServers: storedDnsToServers(backup.ipv4Dns),
        ipv6DnsServers: storedDnsToServers(backup.ipv6Dns),
        ipv4IgnoreAutoDns: backup.ipv4IgnoreAutoDns,
        ipv6IgnoreAutoDns: backup.ipv6IgnoreAutoDns,
    };
}

export default class DnsChangerExtension extends Extension {
    enable() {
        this._enabled = true;
        this._busy = false;
        this._settings = this.getSettings();
        this._indicator = new PanelMenu.Button(0.0, _('DNS Changer'), true);

        const icon = new St.Icon({
            icon_name: 'preferences-system-network-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);
        this._indicator.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this._populateMenu();
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._enabled = false;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }

    _notify(title, message) {
        if (this._enabled)
            Main.notify(title, message);
    }

    _addItem(label, callback) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', callback);
        this._indicator.menu.addMenuItem(item);
        return item;
    }

    _populateMenu() {
        if (!this._indicator || !this._settings)
            return;

        const menu = this._indicator.menu;
        menu.removeAll();
        const providers = loadProviders(this._settings);

        if (this._busy) {
            const busyItem = new PopupMenu.PopupMenuItem(_('Working…'));
            busyItem.setSensitive(false);
            menu.addMenuItem(busyItem);
        } else {
            for (const provider of providers) {
                this._addItem(provider.name, () => this._applyProvider(provider));
            }

            if (providers.length === 0) {
                const emptyItem = new PopupMenu.PopupMenuItem(_('Add DNS providers in Preferences'));
                emptyItem.setSensitive(false);
                menu.addMenuItem(emptyItem);
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addItem(_('Check DNS response time'), () => this._checkSpeeds(providers));
        this._addItem(_('Restore original DNS for this connection'), () => this._restoreOriginalDns());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addItem(_('Manage DNS providers…'), () => this.openPreferences());
    }

    async _applyProvider(provider) {
        if (this._busy)
            return;

        this._busy = true;
        try {
            const connection = await getActiveConnection();
            const backups = readBackups(this._settings);
            if (!backups.has(connection.uuid)) {
                const originalDns = await readProfileDns(connection.uuid);
                backups.set(connection.uuid, {uuid: connection.uuid, ...originalDns});
                saveBackups(this._settings, backups);
            }

            await updateProfileDns(connection.uuid, providerDns(provider));
            const reloadMode = await reloadConnection(connection);
            this._notify(
                _('DNS changed'),
                reloadMode === 'reconnected'
                    ? _(`${provider.name} is active. The connection was reactivated.`)
                    : _(`${provider.name} is active. NetworkManager reapplied the connection.`)
            );
        } catch (error) {
            this._notify(_('Could not change DNS'), error.message);
        } finally {
            this._busy = false;
        }
    }

    async _restoreOriginalDns() {
        if (this._busy)
            return;

        this._busy = true;
        try {
            const connection = await getActiveConnection();
            const backups = readBackups(this._settings);
            const backup = backups.get(connection.uuid);
            if (!backup) {
                this._notify(_('Nothing to restore'), _('This connection has no saved DNS settings from DNS Changer.'));
                return;
            }

            await updateProfileDns(connection.uuid, backupToDns(backup));
            const reloadMode = await reloadConnection(connection);
            backups.delete(connection.uuid);
            saveBackups(this._settings, backups);
            this._notify(
                _('Original DNS restored'),
                reloadMode === 'reconnected'
                    ? _('The saved DNS settings were restored and the connection was reactivated.')
                    : _('The saved DNS settings were restored and reapplied.')
            );
        } catch (error) {
            this._notify(_('Could not restore DNS'), error.message);
        } finally {
            this._busy = false;
        }
    }

    async _checkSpeeds(providers) {
        if (this._busy)
            return;

        if (providers.length === 0) {
            this._notify(_('No DNS providers'), _('Add a provider before checking response times.'));
            return;
        }

        this._busy = true;
        try {
            const mode = await detectProbeMode();
            const results = await Promise.all(providers.map(async provider => {
                const server = provider.ipv4[0] ?? provider.ipv6[0];
                try {
                    return {
                        name: provider.name,
                        ...await probeServer(server, mode),
                    };
                } catch (error) {
                    return {name: provider.name, latency: null, error: error.message};
                }
            }));

            results.sort((first, second) => {
                if (first.latency === null)
                    return second.latency === null ? 0 : 1;
                if (second.latency === null)
                    return -1;
                return first.latency - second.latency;
            });

            const unit = mode === 'dns' ? _('DNS query') : _('ICMP ping (approximate)');
            const lines = results.map(result => result.latency === null
                ? `${result.name}: ${result.error ?? _('unavailable')}`
                : `${result.name}: ${result.latency} ms`);
            this._notify(_('Provider response times'), `${unit}\n${lines.join('\n')}`);
        } catch (error) {
            this._notify(_('Could not check response times'), error.message);
        } finally {
            this._busy = false;
        }
    }
}
