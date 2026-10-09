import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {
    benchmarkServer,
    detectProbeMode,
    getActiveConnection,
    readActiveDnsServers,
    readProfileDns,
    restartNetworkManager,
    updateProfileDns,
} from './network.js';

const QUICK_BENCHMARK_SAMPLE_COUNT = 10;
const FULL_BENCHMARK_SAMPLE_COUNT = 300;
const BENCHMARK_PROVIDER_CONCURRENCY = 2;
const BENCHMARK_REFRESH_INTERVAL = 10 * 60 * 1000;
const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.dns-changer';
const BENCHMARK_METRICS = [
    {key: 'medianLatency', label: 'Median lookup time', description: 'Typical response speed.'},
    {key: 'p95Latency', label: 'P95 lookup time', description: 'Shows how slow queries can get under normal testing.'},
    {key: 'successRate', label: 'Success rate', description: 'Helps avoid a fast but unreliable resolver.'},
    {key: 'consistency', label: 'Consistency', description: 'Shows response-time variation using standard deviation.'},
];
const DEFAULT_PROVIDER_FEATURES = {
    cloudflare: ['DNSSEC'],
    google: ['DNSSEC'],
    quad9: ['DNSSEC', 'Malware blocking'],
};
const REGIONAL_PROVIDER_PRESETS = {
    iran: [
        {
            id: 'regional-iran-electro',
            name: 'الکترو (Electro)',
            ipv4: ['78.157.42.100', '78.157.42.101'],
            ipv6: [],
            features: [],
            custom: true,
        },
        {
            id: 'regional-iran-bagzar',
            name: 'بگذر (Bagzar)',
            ipv4: ['185.55.226.26', '185.55.225.25'],
            ipv6: [],
            features: [],
            custom: true,
        },
        {
            id: 'regional-iran-shekan',
            name: 'شکن (Shekan)',
            ipv4: ['178.22.122.100', '185.51.200.2'],
            ipv6: [],
            features: [],
            custom: true,
        },
        {
            id: 'regional-iran-403',
            name: '۴۰۳ (403 · domestic network only)',
            ipv4: ['10.202.10.202', '10.202.10.102'],
            ipv6: [],
            features: ['Domestic network only'],
            custom: true,
        },
    ],
    russia: [
        {
            id: 'regional-ru-yandex-basic',
            name: 'Yandex DNS (Basic)',
            ipv4: ['77.88.8.8', '77.88.8.1'],
            ipv6: ['2a02:6b8::feed:0ff', '2a02:6b8:0:1::feed:0ff'],
            features: [],
            custom: true,
        },
        {
            id: 'regional-ru-yandex-safe',
            name: 'Yandex DNS (Safe)',
            ipv4: ['77.88.8.88', '77.88.8.2'],
            ipv6: ['2a02:6b8::feed:bad', '2a02:6b8:0:1::feed:bad'],
            features: ['Threat filtering'],
            custom: true,
        },
        {
            id: 'regional-ru-yandex-family',
            name: 'Yandex DNS (Family)',
            ipv4: ['77.88.8.7', '77.88.8.3'],
            ipv6: ['2a02:6b8::feed:a11', '2a02:6b8:0:1::feed:a11'],
            features: ['Threat filtering', 'Adult-content filtering'],
            custom: true,
        },
        {
            id: 'regional-ru-msk-ix',
            name: 'MSK-IX Public DNS',
            ipv4: ['62.76.76.62', '62.76.62.76'],
            ipv6: ['2001:6d0:6d0::2001', '2001:6d0:d6::2001'],
            features: ['Anycast', 'Russian registry filtering'],
            custom: true,
        },
    ],
};

function median(values) {
    if (!values.length)
        return null;

    const sorted = [...values].sort((first, second) => first - second);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function benchmarkMetrics(benchmark) {
    const samples = benchmark?.samples ?? [];
    const completedSamples = samples.filter(sample => sample !== null);
    const latencies = completedSamples
        .filter(sample => sample.latency !== null)
        .map(sample => sample.latency);
    const sortedLatencies = [...latencies].sort((first, second) => first - second);
    const responseCount = latencies.length;
    const completedCount = completedSamples.length;
    const mean = responseCount
        ? latencies.reduce((total, latency) => total + latency, 0) / responseCount
        : null;

    return {
        medianLatency: median(latencies),
        p95Latency: sortedLatencies.length
            ? sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1]
            : null,
        successRate: completedCount ? responseCount / completedCount * 100 : null,
        consistency: mean === null
            ? null
            : Math.sqrt(latencies.reduce(
                (total, latency) => total + (latency - mean) ** 2,
                0
            ) / responseCount),
        responseCount,
        completedCount,
        sampleCount: benchmark?.stats?.sampleCount ?? samples.length,
    };
}

function metricQuality(metricKey, value, benchmark) {
    if (value === null)
        return benchmark?.state === 'complete' ? 'low' : 'unknown';

    if (metricKey === 'successRate')
        return value >= 99 ? 'well' : value >= 95 ? 'ok' : 'low';
    if (metricKey === 'consistency')
        return value <= 10 ? 'well' : value <= 50 ? 'ok' : 'low';
    return value <= 50 ? 'well' : value <= 250 ? 'ok' : 'low';
}

function metricColor(quality) {
    if (quality === 'low')
        return '#ed333b';
    if (quality === 'well')
        return '#33d17a';
    if (quality === 'ok')
        return '#f6d32d';
    return '#9a9996';
}

function benchmarkQuality(metrics, benchmark) {
    if (!benchmark || benchmark.state === 'queued' || benchmark.state === 'failed')
        return 'unknown';

    const qualities = BENCHMARK_METRICS.map(metric =>
        metricQuality(metric.key, metrics[metric.key], benchmark));
    for (const quality of ['low', 'ok', 'unknown']) {
        if (qualities.includes(quality))
            return quality;
    }
    return 'well';
}

function qualityLabel(quality) {
    if (quality === 'low')
        return _('Red · Poor');
    if (quality === 'well')
        return _('Green · Good');
    if (quality === 'ok')
        return _('Yellow · Okay');
    return _('Not rated');
}

function metricValue(metricKey, metrics, benchmark) {
    if (metrics[metricKey] === null)
        return benchmark?.state === 'running' ? _('Collecting…') : _('Not available');

    if (metricKey === 'medianLatency')
        return `${Math.round(metrics.medianLatency)} ms median`;
    if (metricKey === 'p95Latency')
        return `${Math.round(metrics.p95Latency)} ms p95`;
    if (metricKey === 'successRate') {
        const timeouts = metrics.completedCount - metrics.responseCount;
        const timeoutLabel = timeouts === 1 ? _('timeout') : _('timeouts');
        return `${metrics.successRate.toFixed(1)}% · ${timeouts} ${timeoutLabel} / ${metrics.completedCount}`;
    }

    if (metrics.consistency <= 10)
        return `${_('Stable')} · ±${Math.round(metrics.consistency)} ms`;
    if (metrics.consistency <= 50)
        return `±${Math.round(metrics.consistency)} ms`;
    return `${_('Variable')} · ±${Math.round(metrics.consistency)} ms`;
}

function providerFeatures(provider) {
    if (Array.isArray(provider.features))
        return provider.features.filter(Boolean).join(' · ') || _('Not specified');
    if (typeof provider.features === 'string' && provider.features.trim())
        return provider.features.trim();
    if (DEFAULT_PROVIDER_FEATURES[provider.id])
        return DEFAULT_PROVIDER_FEATURES[provider.id].map(feature => _(feature)).join(' · ');
    return _('Not specified');
}

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
        this._benchmarkKind = null;
        this._benchmarkResults = new Map();
        this._lastBenchmarkAt = null;
        this._lastBenchmarkProviderKey = null;
        this._providerRows = new Map();
        this._currentDnsRequest = 0;
        this._benchmarkCancellable = null;
        this._settings = this.getSettings(SETTINGS_SCHEMA);
        this._indicator = new PanelMenu.Button(0.0, _('DNS Changer'), false);

        const icon = new St.Icon({
            icon_name: 'preferences-system-network-symbolic',
            style_class: 'system-status-icon',
        });
        const panelBox = new St.BoxLayout({style: 'spacing: 4px;'});
        this._benchmarkSpinner = new Animation.Spinner(12, {hideOnStop: true});
        this._benchmarkSpinner.accessible_name = _('Benchmarking DNS providers');
        panelBox.add_child(icon);
        panelBox.add_child(this._benchmarkSpinner);
        this._indicator.add_child(panelBox);
        this._menuOpenId = this._indicator.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._refreshCurrentDns();
                void this._checkSpeeds(loadProviders(this._settings));
            }
        });
        this._settingsChangedId = this._settings.connect(
            'changed::dns-providers',
            () => {
                this._lastBenchmarkAt = null;
                this._lastBenchmarkProviderKey = null;
                this._benchmarkCancellable?.cancel();
                this._benchmarkResults = new Map();
                this._populateMenu();
            }
        );

        this._populateMenu();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._enabled = false;
        this._benchmarkCancellable?.cancel();
        this._benchmarkCancellable = null;
        if (this._indicator && this._menuOpenId)
            this._indicator.menu.disconnect(this._menuOpenId);
        this._menuOpenId = null;
        if (this._settings && this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
        this._currentDnsLabel?.destroy();
        this._currentDnsLabel = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._benchmarkResults = null;
        this._providerRows = null;
        this._benchmarkMenuItem = null;
        this._currentDnsLabel = null;
        this._benchmarkSpinner = null;
        this._benchmarkKind = null;
        this._settings = null;
    }

    _notify(title, message) {
        if (this._enabled)
            Main.notify(title, message);
    }

    _addItem(label, callback, keepMenuOpen = false) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', (menuItem, event) => {
            if (keepMenuOpen)
                GObject.signal_stop_emission_by_name(menuItem, 'activate');
            callback(event);
        });
        this._indicator.menu.addMenuItem(item);
        return item;
    }

    _addProviderItem(provider) {
        const item = new PopupMenu.PopupBaseMenuItem();
        const nameLabel = new St.Label({text: provider.name, x_expand: true});
        const metricsLabel = new St.Label({
            style: 'font-size: 0.9em; opacity: 0.9;',
        });
        const spinner = new Animation.Spinner(12, {hideOnStop: true});
        spinner.accessible_name = `${provider.name}: ${_('Benchmarking')}`;
        const summaryDot = new St.Label({text: '●', style: 'font-size: 9px;'});
        const summaryButton = new St.Button({
            child: summaryDot,
            can_focus: true,
            track_hover: true,
            style_class: 'flat',
            accessible_name: _('Click to view benchmark details'),
        });
        summaryButton.connect('clicked', () => this._showBenchmarkDetails(provider));

        item.add_child(nameLabel);
        item.add_child(spinner);
        item.add_child(metricsLabel);
        item.add_child(summaryButton);
        item.connect('activate', () => this._applyProvider(provider));
        item.setSensitive(!this._busy);
        this._indicator.menu.addMenuItem(item);
        this._providerRows.set(provider.id, {item, metricsLabel, spinner, summaryDot, summaryButton, provider});
        this._updateProviderRow(provider.id);
    }

    _updateProviderRow(providerId) {
        const row = this._providerRows?.get(providerId);
        if (!row)
            return;

        const benchmark = this._benchmarkResults?.get(providerId);
        const metrics = benchmarkMetrics(benchmark);
        const testing = benchmark?.state === 'queued' || benchmark?.state === 'running';
        if (testing && !row.spinner.visible)
            row.spinner.play();
        else if (!testing)
            row.spinner.stop();

        if (!benchmark) {
            row.metricsLabel.text = _('— ms median · —% success');
        } else if (benchmark.state === 'queued') {
            row.metricsLabel.text = _('Waiting to benchmark…');
        } else if (benchmark.state === 'running') {
            const medianText = metrics.medianLatency === null
                ? '—'
                : `${Math.round(metrics.medianLatency)} ms`;
            const label = benchmark.kind === 'quick' ? _('Quick test…') : _('Full benchmark…');
            row.metricsLabel.text = `${label} ${metrics.completedCount}/${metrics.sampleCount} · ${medianText} median`;
        } else if (benchmark.state === 'failed') {
            row.metricsLabel.text = _('Benchmark unavailable');
        } else {
            const medianText = metrics.medianLatency === null
                ? '—'
                : `${Math.round(metrics.medianLatency)} ms median`;
            const successText = metrics.successRate === null
                ? '—'
                : `${metrics.successRate.toFixed(1)}% success`;
            row.metricsLabel.text = `${medianText} · ${successText}`;
        }

        const quality = benchmarkQuality(metrics, benchmark);
        row.summaryDot.style = `color: ${metricColor(quality)}; font-size: 9px;`;
        row.summaryButton.accessible_name = `${row.provider.name}: ${_('Overall benchmark')} · ` +
            `${qualityLabel(quality)}. ${_('Click to view benchmark details')}`;
    }

    _showBenchmarkDetails(provider) {
        const benchmark = this._benchmarkResults?.get(provider.id);
        const metrics = benchmarkMetrics(benchmark);
        const dialog = new ModalDialog.ModalDialog({styleClass: 'dns-benchmark-dialog'});
        const details = new St.BoxLayout({vertical: true, style: 'spacing: 10px;'});
        const mode = !benchmark?.mode
            ? _('Not tested')
            : benchmark.mode === 'icmp' ? _('ICMP ping') : _('UDP');
        const entries = [
            [
                _('Test'),
                benchmark
                    ? `${benchmark.kind === 'quick' ? _('Quick') : _('Full')} · ${metrics.completedCount}/${metrics.sampleCount}`
                    : _('Not tested'),
                benchmark?.kind === 'quick'
                    ? _('A quick estimate. Run the full benchmark for more reliable results.')
                    : _('The full benchmark collects 300 probes per provider.'),
            ],
            ...BENCHMARK_METRICS.map(metric => [
                _(metric.label),
                metricValue(metric.key, metrics, benchmark),
                _(metric.description),
                metric.key,
            ]),
            [
                _('Protocol'),
                mode,
                benchmark?.mode === 'icmp'
                    ? _('DNS checks were unavailable, so this is a ping approximation.')
                    : benchmark?.mode
                        ? _('The benchmark sends standard DNS queries over UDP.')
                        : _('Run the benchmark to determine the test protocol.'),
            ],
            [
                _('Features'),
                providerFeatures(provider),
                _('Provider feature information is descriptive and is not tested by this benchmark.'),
            ],
        ];

        dialog.contentLayout.add_child(new St.Label({
            text: provider.name,
            style: 'font-size: 1.2em; font-weight: bold;',
        }));
        const overallQuality = benchmarkQuality(metrics, benchmark);
        dialog.contentLayout.add_child(new St.Label({
            text: `${_('Overall benchmark')}: ● ${qualityLabel(overallQuality)}`,
            style: `color: ${metricColor(overallQuality)};`,
        }));
        dialog.contentLayout.add_child(new St.Label({
            text: _('The overall color reflects the lowest-rated metric.'),
            style: 'font-size: 0.9em; opacity: 0.8;',
        }));
        for (const [title, value, description, metricKey] of entries) {
            const entry = new St.BoxLayout({vertical: true, style: 'spacing: 3px;'});
            const heading = new St.BoxLayout({style: 'spacing: 12px;'});
            heading.add_child(new St.Label({text: title, x_expand: true, style: 'font-weight: bold;'}));
            heading.add_child(new St.Label({text: value}));
            entry.add_child(heading);
            if (metricKey) {
                const quality = metricQuality(metricKey, metrics[metricKey], benchmark);
                entry.add_child(new St.Label({
                    text: `● ${qualityLabel(quality)}`,
                    style: `color: ${metricColor(quality)};`,
                }));
            }
            entry.add_child(new St.Label({
                text: description,
                style: 'font-size: 0.9em; opacity: 0.8;',
            }));
            details.add_child(entry);
        }
        dialog.contentLayout.add_child(details);
        dialog.setButtons([{label: _('Close'), action: () => dialog.close()}]);
        dialog.open();
    }

    _populateMenu() {
        if (!this._indicator || !this._settings)
            return;

        const menu = this._indicator.menu;
        menu.removeAll();
        this._providerRows.clear();
        this._currentDnsLabel = null;
        const providers = loadProviders(this._settings);

        const currentDnsItem = new PopupMenu.PopupBaseMenuItem();
        this._currentDnsLabel = new St.Label({
            text: _('Current DNS: detecting…'),
            x_expand: true,
        });
        currentDnsItem.add_child(this._currentDnsLabel);
        currentDnsItem.setSensitive(false);
        menu.addMenuItem(currentDnsItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._refreshCurrentDns();

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

        this._addItem(_('System (restore original DNS)'), () => this._restoreOriginalDns());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const benchmarkItem = this._addItem(_('Run full DNS benchmark'), () => {
            void this._checkSpeeds(loadProviders(this._settings), true);
        }, true);
        benchmarkItem.setSensitive(providers.length > 0 && this._benchmarkKind !== 'full');
        this._benchmarkMenuItem = benchmarkItem;
        this._addItem(_('Add provider…'), () => this.openPreferences());

        const regionalProvidersItem = new PopupMenu.PopupSubMenuMenuItem(_('Import regional providers'));
        const iranItem = new PopupMenu.PopupMenuItem(_('Iran (4 providers)'));
        iranItem.connect('activate', () => this._importRegionalProviders('iran'));
        regionalProvidersItem.menu.addMenuItem(iranItem);
        const russiaItem = new PopupMenu.PopupMenuItem(_('Russia (Yandex DNS and MSK-IX)'));
        russiaItem.connect('activate', () => this._importRegionalProviders('russia'));
        regionalProvidersItem.menu.addMenuItem(russiaItem);
        menu.addMenuItem(regionalProvidersItem);
    }

    _importRegionalProviders(region) {
        const presets = REGIONAL_PROVIDER_PRESETS[region];
        if (!presets || !this._settings)
            return;

        const providers = loadProviders(this._settings);
        const ids = new Set(providers.map(provider => provider.id));
        const names = new Set(providers.map(provider => provider.name.normalize('NFKC').toLocaleLowerCase()));
        const addressKey = provider => `${[...provider.ipv4].sort().join(',')}|${[...provider.ipv6].sort().join(',')}`;
        const addresses = new Set(providers.map(addressKey));
        const imported = presets.filter(provider => {
            const normalizedName = provider.name.normalize('NFKC').toLocaleLowerCase();
            const key = addressKey(provider);
            if (ids.has(provider.id) || names.has(normalizedName) || addresses.has(key))
                return false;

            ids.add(provider.id);
            names.add(normalizedName);
            addresses.add(key);
            return true;
        });

        if (imported.length === 0) {
            this._notify(_('Regional providers already added'), _('These DNS providers are already in your provider list.'));
            return;
        }

        this._settings.set_strv(
            'dns-providers',
            [...providers, ...imported].map(provider => JSON.stringify(provider))
        );
        const regionName = region === 'iran' ? _('Iran') : _('Russia');
        this._notify(
            _('Regional DNS providers added'),
            `${regionName}: ${imported.map(provider => provider.name).join(', ')}\n` +
                _('They are saved as custom providers and can be removed in Preferences.')
        );
    }

    async _refreshCurrentDns() {
        const label = this._currentDnsLabel;
        if (!label)
            return;

        const requestId = ++this._currentDnsRequest;
        label.text = _('Current DNS: detecting…');

        try {
            const connection = await getActiveConnection();
            const servers = await readActiveDnsServers(connection);
            if (requestId !== this._currentDnsRequest || label !== this._currentDnsLabel)
                return;

            label.text = servers.length
                ? `${_('Current DNS')}: ${servers.join(', ')}`
                : _('Current DNS: automatic (system)');
        } catch (error) {
            if (requestId === this._currentDnsRequest && label === this._currentDnsLabel)
                label.text = _('Current DNS: unavailable');
            console.warn(`DNS Changer: could not read active DNS servers: ${error.message}`);
        }
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
            await restartNetworkManager();
            this._notify(
                _('DNS changed'),
                _(`${provider.name} is active. NetworkManager was restarted to apply the DNS settings.`)
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
            await restartNetworkManager();
            backups.delete(connection.uuid);
            saveBackups(this._settings, backups);
            this._notify(
                _('Original DNS restored'),
                _('The saved DNS settings were restored and NetworkManager was restarted to apply them.')
            );
        } catch (error) {
            this._notify(_('Could not restore DNS'), error.message);
        } finally {
            this._busy = false;
        }
    }

    async _checkSpeeds(providers, fullBenchmark = false) {
        if (!this._enabled || providers.length === 0 ||
            (this._benchmarking && (!fullBenchmark || this._benchmarkKind === 'full')))
            return;

        const providerKey = JSON.stringify(providers.map(provider => ({
            id: provider.id,
            ipv4: provider.ipv4,
            ipv6: provider.ipv6,
        })));
        const hasFreshResults = this._lastBenchmarkAt !== null &&
            this._lastBenchmarkProviderKey === providerKey &&
            GLib.get_monotonic_time() - this._lastBenchmarkAt < BENCHMARK_REFRESH_INTERVAL * 1000;
        if (!fullBenchmark && hasFreshResults)
            return;

        this._benchmarkCancellable?.cancel();
        const sampleCount = fullBenchmark ? FULL_BENCHMARK_SAMPLE_COUNT : QUICK_BENCHMARK_SAMPLE_COUNT;
        this._lastBenchmarkAt = null;
        this._lastBenchmarkProviderKey = null;
        this._benchmarking = true;
        this._benchmarkKind = fullBenchmark ? 'full' : 'quick';
        this._benchmarkMenuItem?.setSensitive(!fullBenchmark);
        const cancellable = new Gio.Cancellable();
        this._benchmarkCancellable = cancellable;
        const benchmarks = this._benchmarkResults;
        const isCurrent = () => this._enabled && this._benchmarkCancellable === cancellable;
        this._benchmarkSpinner.play();
        for (const provider of providers) {
            benchmarks.set(provider.id, {
                state: 'queued',
                kind: this._benchmarkKind,
                mode: null,
                samples: Array(sampleCount).fill(null),
                completedCount: 0,
                stats: null,
            });
            this._updateProviderRow(provider.id);
        }
        try {
            const mode = await detectProbeMode(cancellable);
            if (!isCurrent() || cancellable.is_cancelled())
                return;

            let nextProvider = 0;
            const benchmarkProvider = async provider => {
                const server = provider.ipv4[0] ?? provider.ipv6[0];
                const benchmark = benchmarks.get(provider.id);
                benchmark.state = 'running';
                benchmark.mode = mode;
                this._updateProviderRow(provider.id);

                const stats = await benchmarkServer(server, mode, sampleCount, (index, sample) => {
                    if (!isCurrent() || cancellable.is_cancelled())
                        return;
                    benchmark.samples[index] = sample;
                    benchmark.completedCount++;
                    if (benchmark.completedCount % 10 === 0 ||
                        benchmark.completedCount === sampleCount) {
                        this._updateProviderRow(provider.id);
                    }
                }, cancellable);
                if (!stats || !isCurrent() || cancellable.is_cancelled())
                    return;

                benchmark.state = 'complete';
                benchmark.stats = stats;
                this._updateProviderRow(provider.id);
            };
            const workers = Array.from({
                length: Math.min(providers.length, BENCHMARK_PROVIDER_CONCURRENCY),
            }, async () => {
                while (nextProvider < providers.length && isCurrent() && !cancellable.is_cancelled())
                    await benchmarkProvider(providers[nextProvider++]);
            });
            await Promise.all(workers);
            if (isCurrent() && providers.every(provider =>
                benchmarks.get(provider.id)?.state === 'complete')) {
                this._lastBenchmarkAt = GLib.get_monotonic_time();
                this._lastBenchmarkProviderKey = providerKey;
            }
        } catch (error) {
            if (isCurrent() && !cancellable.is_cancelled()) {
                cancellable.cancel();
                for (const provider of providers) {
                    const benchmark = benchmarks.get(provider.id);
                    if (benchmark.state === 'queued' || benchmark.state === 'running')
                        benchmark.state = 'failed';
                    this._updateProviderRow(provider.id);
                }
                this._notify(_('Could not benchmark DNS providers'), error.message);
            }
        } finally {
            if (isCurrent()) {
                this._benchmarking = false;
                this._benchmarkKind = null;
                this._benchmarkCancellable = null;
                this._benchmarkSpinner.stop();
                this._benchmarkMenuItem?.setSensitive(loadProviders(this._settings).length > 0);
            }
        }
    }
}
