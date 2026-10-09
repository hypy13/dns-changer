import Gio from 'gi://Gio';

const MANAGED_CONNECTION_TYPES = new Set([
    '802-3-ethernet',
    '802-11-wireless',
    'ethernet',
    'wifi',
    'gsm',
    'cdma',
    'infiniband',
]);

export async function runCommand(argv) {
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
        process.communicate_utf8_async(null, null, (subprocess, result) => {
            try {
                const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                resolve({
                    successful: subprocess.get_successful(),
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                });
            } catch (error) {
                reject(error);
            }
        });
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

export async function reloadConnection(connection) {
    try {
        await runChecked(['nmcli', 'device', 'reapply', connection.device]);
        return 'reapplied';
    } catch (reapplyError) {
        try {
            await runChecked([
                'nmcli', '--wait', '20',
                'connection', 'up', connection.uuid,
                'ifname', connection.device,
            ]);
            return 'reconnected';
        } catch (reconnectError) {
            throw new Error(
                `The DNS settings were saved, but NetworkManager could not apply them. ` +
                `Reapply: ${reapplyError.message} Reconnect: ${reconnectError.message}`
            );
        }
    }
}

export async function detectProbeMode() {
    try {
        await runCommand(['dig', '-v']);
        return 'dns';
    } catch (error) {
        if (!error.commandUnavailable)
            throw error;
    }

    try {
        await runCommand(['ping', '-V']);
        return 'icmp';
    } catch (error) {
        if (error.commandUnavailable)
            throw new Error('Install dig or ping to check DNS provider response times.');
        throw error;
    }
}

export async function probeServer(server, mode) {
    const isIpv6 = server.includes(':');
    const argv = mode === 'dns'
        ? ['dig', '+time=1', '+tries=1', '+noall', '+comments', '+stats', `@${server}`, 'example.com', 'A']
        : ['ping', '-n', '-c', '1', '-W', '1', ...(isIpv6 ? ['-6'] : []), server];
    const result = await runCommand(argv);
    const output = `${result.stdout}\n${result.stderr}`;

    if (mode === 'dns') {
        const status = output.match(/status:\s*([A-Z]+)/)?.[1];
        const latency = output.match(/Query time:\s*(\d+)\s*msec/i)?.[1];
        if (status === 'NOERROR' && latency !== undefined) {
            return {server, latency: Number(latency), mode};
        }

        return {
            server,
            latency: null,
            mode,
            error: status ? `DNS ${status}` : 'No DNS response',
        };
    }

    const latency = output.match(/time[=<]([\d.]+)\s*ms/i)?.[1];
    if (latency !== undefined)
        return {server, latency: Number(latency), mode};

    return {server, latency: null, mode, error: 'No ping response'};
}
