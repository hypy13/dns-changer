import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {
    benchmarkServer,
    detectProbeMode,
    getActiveConnection,
    readProfileDns,
    reloadConnection,
    updateProfileDns,
} from './network.js';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.dns-changer';

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
        this._benchmarking = false;
        this._benchmarkResults = new Map();
        this._providerRows = new Map();
        this._settings = this.getSettings(SETTINGS_SCHEMA);
        this._indicator = new PanelMenu.Button(0.0, _('DNS Changer'), false);

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
        this._benchmarkResults = null;
        this._providerRows = null;
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

    _addProviderItem(provider) {
        const item = new PopupMenu.PopupBaseMenuItem();
        const nameLabel = new St.Label({text: provider.name, x_expand: true});
        const metricsLabel = new St.Label({
            style: 'font-size: 0.9em; opacity: 0.9;',
        });
        const dotsBox = new St.BoxLayout({style: 'spacing: 2px;'});
        const dots = Array.from({length: 4}, () => {
            const dot = new St.Label({text: '●'});
            dotsBox.add_child(dot);
            return dot;
        });

        item.add_child(nameLabel);
        item.add_child(metricsLabel);
        item.add_child(dotsBox);
        item.connect('activate', () => this._applyProvider(provider));
        item.setSensitive(!this._busy);
        this._indicator.menu.addMenuItem(item);
        this._providerRows.set(provider.id, {item, metricsLabel, dots});
        this._updateProviderRow(provider.id);
    }

    _updateProviderRow(providerId) {
        const row = this._providerRows?.get(providerId);
        if (!row)
            return;

        const benchmark = this._benchmarkResults?.get(providerId);
        const samples = benchmark?.samples ?? Array(4).fill(null);
        const successful = samples.filter(sample => sample !== null && sample.latency !== null);
        const latencies = successful.map(sample => sample.latency);
        const averageLatency = latencies.length
            ? latencies.reduce((total, latency) => total + latency, 0) / latencies.length
            : null;

        if (!benchmark) {
            row.metricsLabel.text = _('— ms · — q/s · 0/4');
        } else if (benchmark.state === 'running') {
            const latencyText = averageLatency === null ? '—' : `${Math.round(averageLatency)}`;
            row.metricsLabel.text = `${latencyText} ms · ${_('testing')} · ${successful.length}/4`;
        } else {
            const stats = benchmark.stats;
            const latencyText = stats.averageLatency === null
                ? '—'
                : `${Math.round(stats.averageLatency)}`;
            const rateText = stats.throughput === null
                ? '—'
                : `${Math.round(stats.throughput)}`;
            const responseSizeText = stats.averageResponseBytes === null
                ? ''
                : ` · ${Math.round(stats.averageResponseBytes)} B`;
            const rateUnit = stats.throughput === null ? 'ping' : 'q/s';
            row.metricsLabel.text = `${latencyText} ms · ${rateText} ${rateUnit} · ` +
                `${stats.responseCount}/${stats.sampleCount}${responseSizeText}`;
        }

        row.dots.forEach((dot, index) => {
            const sample = samples[index];
            const color = sample === null
                ? '#ffffff; text-shadow: 0 0 2px #000000'
                : sample.latency === null || sample.latency > 250
                    ? '#ed333b'
                    : sample.latency <= 50
                        ? '#33d17a'
                        : '#ffffff; text-shadow: 0 0 2px #000000';
            dot.style = `color: ${color}; font-size: 9px;`;
        });
    }

    _populateMenu() {
        if (!this._indicator || !this._settings)
            return;

        const menu = this._indicator.menu;
        menu.removeAll();
        this._providerRows.clear();
        const providers = loadProviders(this._settings);

        if (this._busy) {
            const busyItem = new PopupMenu.PopupMenuItem(_('Working…'));
            busyItem.setSensitive(false);
            menu.addMenuItem(busyItem);
        } else {
            for (const provider of providers)
                this._addProviderItem(provider);

            if (providers.length === 0) {
                const emptyItem = new PopupMenu.PopupMenuItem(_('Add DNS providers in Preferences'));
                emptyItem.setSensitive(false);
                menu.addMenuItem(emptyItem);
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const benchmarkItem = this._addItem(
            this._benchmarking ? _('Benchmarking…') : _('Benchmark DNS providers'),
            () => this._checkSpeeds(providers)
        );
        benchmarkItem.setSensitive(!this._busy && !this._benchmarking);
        this._addItem(_('Restore original DNS for this connection'), () => this._restoreOriginalDns());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addItem(_('Add provider…'), () => this.openPreferences());
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
        if (this._busy || this._benchmarking)
            return;

        if (providers.length === 0) {
            this._notify(_('No DNS providers'), _('Add a provider before checking response times.'));
            return;
        }

        this._benchmarking = true;
        try {
            const mode = await detectProbeMode();
            const sampleCount = 4;
            const results = await Promise.all(providers.map(async provider => {
                const server = provider.ipv4[0] ?? provider.ipv6[0];
                const benchmark = {
                    state: 'running',
                    mode,
                    samples: Array(sampleCount).fill(null),
                    stats: null,
                };
                this._benchmarkResults.set(provider.id, benchmark);
                this._updateProviderRow(provider.id);

                const stats = await benchmarkServer(server, mode, sampleCount, (index, sample) => {
                    benchmark.samples[index] = sample;
                    this._updateProviderRow(provider.id);
                });
                benchmark.state = 'complete';
                benchmark.stats = stats;
                this._updateProviderRow(provider.id);
                return {name: provider.name, ...stats};
            }));

            results.sort((first, second) => {
                if (first.averageLatency === null)
                    return second.averageLatency === null ? 0 : 1;
                if (second.averageLatency === null)
                    return -1;
                return first.averageLatency - second.averageLatency;
            });

            const unit = mode === 'dns'
                ? _('DNS benchmark · average latency / burst queries per second / responses')
                : _('ICMP ping · average latency / responses (install dig for DNS throughput)');
            const lines = results.map(result => {
                const latency = result.averageLatency === null
                    ? _('unavailable')
                    : `${Math.round(result.averageLatency)} ms`;
                const throughput = result.throughput === null
                    ? ''
                    : ` · ${Math.round(result.throughput)} q/s`;
                return `${result.name}: ${latency}${throughput} · ${result.responseCount}/${result.sampleCount}`;
            });
            this._notify(_('DNS benchmark complete'), `${unit}\n${lines.join('\n')}`);
        } catch (error) {
            this._notify(_('Could not benchmark DNS providers'), error.message);
        } finally {
            this._benchmarking = false;
        }
    }
}
