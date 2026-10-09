# DNS Changer

A GNOME Shell extension for switching DNS providers on the active NetworkManager connection. It starts with Cloudflare, Google, and Quad9, and lets you add custom IPv4 and IPv6 DNS servers in Preferences. The provider-switching flow is inspired by [Sanad](https://github.com/MirS0bhan/sanad).

## Features

- Switch the active Ethernet, Wi-Fi, or mobile broadband profile to a DNS provider.
- Add and remove custom providers in the extension preferences.
- Restore each connection profile's DNS settings from before DNS Changer first changed it.
- Reapply the active NetworkManager device after a DNS change. If reapply is unsupported, reactivate the connection profile.
- Compare provider response times using a DNS query through `dig`. If `dig` is unavailable, compare ICMP ping latency and label it as an approximation.

The speed check probes each provider's first configured IPv4 server, or its first IPv6 server when no IPv4 server is configured. DNS query timing is a better measure of resolver response than ping; ping only measures network latency to the server address.

## Requirements

- GNOME Shell 45 or newer
- NetworkManager with `nmcli`
- `dig` for DNS query timing, or `ping` for the fallback latency check

Changing a saved system connection may require authorization from the desktop's PolicyKit agent. DNS Changer does not use `sudo` or a privileged helper.

## Build and install

```sh
make pack
gnome-extensions install --force dist/dns-changer@hossein.dev.shell-extension.zip
gnome-extensions enable dns-changer@hossein.dev
```

To remove generated build files:

```sh
make clean
```

## Use

Open the DNS Changer icon in the top panel and choose a provider. Use **Manage DNS providers…** to add custom servers. The extension saves the original IPv4 and IPv6 DNS values and the NetworkManager automatic-DNS flags for each changed connection profile. **Restore original DNS for this connection** restores those values and removes the saved backup for that profile.

DNS settings are stored on the active NetworkManager profile, so they persist when reconnecting to that profile. A connection reactivation can briefly interrupt network traffic if NetworkManager cannot apply the DNS update in place.
