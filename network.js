import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MANAGED_CONNECTION_TYPES = new Set([
    '802-3-ethernet',
    '802-11-wireless',
    'ethernet',
    'wifi',
    'gsm',
    'cdma',
    'infiniband',
]);

export async function runCommand(argv, cancellable = null) {
    let process;

    try {
        process = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
    } catch (error) {
        const unavailable = new Error(`${argv[0]} could not be started: ${error.message}`);
        unavailable.commandUnavailable = true;
        throw unavailable;
    }

    return new Promise((resolve, reject) => {
        const cancellationId = cancellable?.connect(() => process.force_exit()) ?? 0;
        const finish = callback => {
            if (cancellationId)
                cancellable.disconnect(cancellationId);
            callback();
        };

        try {
            process.communicate_utf8_async(null, cancellable, (subprocess, result) => {
                try {
                    const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                    finish(() => resolve({
                        successful: subprocess.get_successful(),
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                    }));
                } catch (error) {
                    finish(() => reject(error));
                }
            });
        } catch (error) {
            finish(() => reject(error));
        }
    });
}

async function runChecked(argv) {
    const result = await runCommand(argv);
    if (!result.successful) {
        const details = (result.stderr || result.stdout).trim();
        throw new Error(details || `${argv[0]} exited unsuccessfully.`);
    }

    return result.stdout.replace(/\r?\n$/, '');
}

export async function getActiveConnection() {
    const output = await runChecked([
        'nmcli', '--terse', '--escape', 'no',
        '--fields', 'UUID,TYPE,DEVICE',
        'connection', 'show', '--active',
    ]);

    const connection = output.split(/\r?\n/)
        .map(line => {
            const [uuid, type, ...deviceParts] = line.split(':');
            return {uuid, type, device: deviceParts.join(':')};
        })
        .find(item => item.uuid &&
            item.device &&
            item.device !== '--' &&
            MANAGED_CONNECTION_TYPES.has(item.type));

    if (!connection) {
        throw new Error('No active Ethernet, Wi-Fi, or mobile broadband connection was found.');
    }

    return connection;
}

export async function readActiveDnsServers(connection) {
    const output = await runChecked([
        'nmcli', '--get-values', 'IP4.DNS,IP6.DNS',
        'device', 'show', connection.device,
    ]);

    return output.split(/\r?\n/)
        .map(value => value.trim())
        .filter(value => value && value !== '--');
}

function normalizeNmValue(value) {
    if (!value || value.trim() === '--')
        return '';

    return value.trim();
}

export async function readProfileDns(uuid) {
    const output = await runChecked([
        'nmcli', '--get-values',
        'ipv4.dns,ipv4.ignore-auto-dns,ipv6.dns,ipv6.ignore-auto-dns',
        'connection', 'show', uuid,
    ]);
    const values = output.split(/\r?\n/);

    if (values.length < 4)
        throw new Error('NetworkManager returned incomplete DNS settings for this connection.');

    return {
        ipv4Dns: normalizeNmValue(values[0]),
        ipv4IgnoreAutoDns: normalizeNmValue(values[1]) === 'yes' ? 'yes' : 'no',
        ipv6Dns: normalizeNmValue(values[2]),
        ipv6IgnoreAutoDns: normalizeNmValue(values[3]) === 'yes' ? 'yes' : 'no',
    };
}

function dnsValue(servers) {
    return servers.filter(Boolean).join(' ');
}

export async function updateProfileDns(uuid, dnsSettings) {
    await runChecked([
        'nmcli', 'connection', 'modify', uuid,
        'ipv4.ignore-auto-dns', dnsSettings.ipv4IgnoreAutoDns,
        'ipv4.dns', dnsValue(dnsSettings.ipv4DnsServers ?? []),
        'ipv6.ignore-auto-dns', dnsSettings.ipv6IgnoreAutoDns,
        'ipv6.dns', dnsValue(dnsSettings.ipv6DnsServers ?? []),
    ]);
}

export async function restartNetworkManager() {
    try {
        await runChecked(['systemctl', 'restart', 'NetworkManager.service']);
    } catch (error) {
        throw new Error(
            `The DNS settings were saved, but NetworkManager could not be restarted to apply them: ${error.message}`
        );
    }
}

export async function detectProbeMode(cancellable = null) {
    try {
        await runCommand(['dig', '-v'], cancellable);
        return 'dns';
    } catch (error) {
        if (!error.commandUnavailable)
            throw error;
    }

    try {
        await runCommand(['ping', '-V'], cancellable);
        return 'icmp';
    } catch (error) {
        if (error.commandUnavailable)
            throw new Error('Install dig or ping to check DNS provider response times.');
        throw error;
    }
}

export async function probeServer(server, mode, cancellable = null) {
    const isIpv6 = server.includes(':');
    const argv = mode === 'dns'
        ? ['dig', '+time=1', '+tries=1', '+noall', '+comments', '+stats', `@${server}`, 'example.com', 'A']
        : ['ping', '-n', '-c', '1', '-W', '1', ...(isIpv6 ? ['-6'] : []), server];
    const result = await runCommand(argv, cancellable);
    const output = `${result.stdout}\n${result.stderr}`;

    if (mode === 'dns') {
        const status = output.match(/status:\s*([A-Z]+)/)?.[1];
        const latency = output.match(/Query time:\s*(\d+)\s*msec/i)?.[1];
        const answers = output.match(/\bANSWER:\s*(\d+)/i)?.[1];
        const responseBytes = output.match(/MSG SIZE rcvd:\s*(\d+)/i)?.[1];
        if (status === 'NOERROR' && latency !== undefined) {
            return {
                server,
                latency: Number(latency),
                mode,
                status,
                answers: answers === undefined ? null : Number(answers),
                responseBytes: responseBytes === undefined ? null : Number(responseBytes),
            };
        }

        return {
            server,
            latency: null,
            mode,
            status: status ?? null,
            error: status ? `DNS ${status}` : 'No DNS response',
        };
    }

    const latency = output.match(/time[=<]([\d.]+)\s*ms/i)?.[1];
    if (latency !== undefined)
        return {server, latency: Number(latency), mode};

    return {server, latency: null, mode, error: 'No ping response'};
}

export async function benchmarkServer(server, mode, sampleCount, onSample, cancellable = null) {
    const startedAt = GLib.get_monotonic_time();
    const samples = Array(sampleCount);
    let nextIndex = 0;
    const workerCount = Math.min(sampleCount, 10);
    const workers = Array.from({length: workerCount}, async () => {
        while (nextIndex < sampleCount && !cancellable?.is_cancelled()) {
            const index = nextIndex++;
            let sample;
            try {
                sample = await probeServer(server, mode, cancellable);
            } catch (error) {
                if (cancellable?.is_cancelled())
                    break;
                sample = {server, mode, latency: null, error: error.message};
            }

            if (cancellable?.is_cancelled())
                break;

            samples[index] = sample;
            onSample?.(index, sample);
        }
    });
    await Promise.all(workers);
    if (cancellable?.is_cancelled())
        return null;

    const elapsedMs = (GLib.get_monotonic_time() - startedAt) / 1000;
    const successfulSamples = samples.filter(sample => sample.latency !== null);
    const latencies = successfulSamples.map(sample => sample.latency);
    const sortedLatencies = [...latencies].sort((first, second) => first - second);
    const responseSizes = successfulSamples
        .map(sample => sample.responseBytes)
        .filter(size => size !== null && size !== undefined);
    const medianLatency = sortedLatencies.length
        ? sortedLatencies.length % 2 === 1
            ? sortedLatencies[Math.floor(sortedLatencies.length / 2)]
            : (sortedLatencies[sortedLatencies.length / 2 - 1] +
                sortedLatencies[sortedLatencies.length / 2]) / 2
        : null;
    const p95Latency = sortedLatencies.length
        ? sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1]
        : null;
    const meanLatency = latencies.length
        ? latencies.reduce((total, latency) => total + latency, 0) / latencies.length
        : null;
    const consistency = meanLatency === null
        ? null
        : Math.sqrt(latencies.reduce(
            (total, latency) => total + (latency - meanLatency) ** 2,
            0
        ) / latencies.length);

    return {
        server,
        mode,
        samples,
        sampleCount,
        responseCount: successfulSamples.length,
        medianLatency,
        p95Latency,
        consistency,
        averageLatency: latencies.length
            ? meanLatency
            : null,
        minLatency: latencies.length ? Math.min(...latencies) : null,
        maxLatency: latencies.length ? Math.max(...latencies) : null,
        throughput: mode === 'dns' && elapsedMs > 0
            ? successfulSamples.length / (elapsedMs / 1000)
            : null,
        averageResponseBytes: responseSizes.length
            ? responseSizes.reduce((total, size) => total + size, 0) / responseSizes.length
            : null,
    };
}
