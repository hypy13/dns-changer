# DNS Changer

A GNOME Shell extension for switching DNS providers on the active NetworkManager connection. It starts with Cloudflare, Google, and Quad9, and lets you add custom IPv4 and IPv6 DNS servers in Preferences. The provider-switching flow is inspired by [Sanad](https://github.com/MirS0bhan/sanad).

## Features

- Switch the active Ethernet, Wi-Fi, or mobile broadband profile to a DNS provider.
- Add and remove custom providers in the extension preferences.
- Restore each connection profile's DNS settings from before DNS Changer first changed it.
- Reapply the active NetworkManager device after a DNS change. If reapply is unsupported, reactivate the connection profile.
- Benchmark provider average DNS latency, approximate burst query throughput, and response rate with four probes. The panel menu shows the results and four colored response indicators: green for up to 50 ms, white for a slower response, and red for a timeout or a response over 250 ms. If `dig` is unavailable, it shows ICMP ping latency as an approximation.

The benchmark probes each provider's first configured IPv4 server, or its first IPv6 server when no IPv4 server is configured. DNS burst throughput is an approximate client-side rate from four concurrent queries. DNS query timing measures resolver response; ping only measures network latency to the server address.

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
