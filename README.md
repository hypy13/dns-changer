# DNS Changer

A GNOME Shell extension for switching DNS providers on the active NetworkManager connection. It starts with Cloudflare, Google, and Quad9, and lets you add custom IPv4 and IPv6 DNS servers in Preferences. The provider-switching flow is inspired by [Sanad](https://github.com/MirS0bhan/sanad).

## Features

- Switch the active Ethernet, Wi-Fi, or mobile broadband profile to a DNS provider.
- Add and remove custom providers in the extension preferences.
- Import regional DNS presets from the panel menu: Electro, Bagzar, Shekan, and 403 for Iran; Yandex DNS modes and MSK-IX for Russia.
- Restore each connection profile's DNS settings from before DNS Changer first changed it.
- Reapply the active NetworkManager device after a DNS change. If reapply is unsupported, reactivate the connection profile.
- Benchmark each provider with 300 probes. Four panel indicators show median lookup time, P95 lookup time, success rate, and consistency independently: green means well, white means okay, and red means low. For latency, green is up to 50 ms and red is over 250 ms; success is green at 99% or better and red below 95%; consistency is green at 10 ms variation or less and red above 50 ms. Values between those thresholds are white. Click any indicator for the benchmark details, including protocol and provider features. If `dig` is unavailable, the latency indicators use ICMP ping as an approximation.

Choose **Benchmark DNS providers** from the panel menu to start a benchmark for every configured provider. Each benchmark sends 300 DNS queries to that provider, or 300 ICMP probes when `dig` is unavailable. Opening the menu alone does not send these probes.

The benchmark probes each provider's first configured IPv4 server, or its first IPv6 server when no IPv4 server is configured. It runs up to ten probes per provider at a time. DNS throughput is an approximate client-side rate across the benchmark; DNS query timing measures resolver response, while ping only measures network latency to the server address. Feature labels are provider metadata and are not tested by the benchmark.

Regional presets are saved as custom providers and can be removed in Preferences. The 403 addresses are private-network addresses and work only on supported domestic Iranian networks. MSK-IX documents filtering against Russia's prohibited-sites registry. Test the imported options on your own ISP; local DNS performance and reachability vary by network.

## Requirements

- GNOME Shell 45 or newer
- NetworkManager with `nmcli`
- `dig` for DNS latency and throughput, or `ping` for the fallback latency check

Changing a saved system connection may require authorization from the desktop's PolicyKit agent. DNS Changer does not use `sudo` or a privileged helper.

## Build and install

```sh
make install
```

`make install` builds the bundle and installs it for the current user. GNOME Shell may need a new session to discover a manually installed extension. Log out and back in, then enable it:

```sh
gnome-extensions enable dns-changer@hossein.dev
```

You can also run `make enable` after starting the new session. If you already built the bundle and are inside `dist/`, install it with:

```sh
gnome-extensions install --force dns-changer@hossein.dev.shell-extension.zip
```

Then log out and back in before enabling it.

To remove generated build files:

```sh
make clean
```

## Use

Open the DNS Changer icon in the top panel and choose a provider. Use **Add provider…** to add or remove custom servers in Preferences. The extension saves the original IPv4 and IPv6 DNS values and the NetworkManager automatic-DNS flags for each changed connection profile. **Restore original DNS for this connection** restores those values and removes the saved backup for that profile.

DNS settings are stored on the active NetworkManager profile, so they persist when reconnecting to that profile. A connection reactivation can briefly interrupt network traffic if NetworkManager cannot apply the DNS update in place.

## License

DNS Changer is licensed under GPL-2.0-or-later. See [LICENSE](LICENSE).
