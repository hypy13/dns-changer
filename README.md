# DNS Changer for GNOME Shell

Switch DNS providers from the GNOME top panel. DNS Changer is a GNOME Shell extension for Linux that lets you choose the DNS servers used by your active Wi-Fi, Ethernet, or mobile broadband connection managed by NetworkManager. Choose a built-in provider, add your own IPv4 or IPv6 DNS servers, compare DNS response times, and restore your original settings without manually editing each connection profile.

## Features

- **Switch DNS providers quickly:** Choose Cloudflare, Google Public DNS, or Quad9 from the panel menu.
- **Use custom DNS servers:** Add and remove providers with your own IPv4 and IPv6 addresses in Preferences.
- **Compare provider performance:** Run a quick check or a full DNS benchmark to review response speed, reliability, and consistency on your network.
- **Restore your previous settings:** DNS Changer saves a connection's original DNS settings before changing them, so you can restore them from the panel menu.
- **Keep settings with your connection:** DNS choices are saved to the active NetworkManager connection profile and remain in place when you reconnect to that profile.

## DNS provider checks

The first time you open the menu, DNS Changer runs a quick check with 10 probes per provider. It reuses those results for ten minutes; after that, opening the menu starts a fresh quick check. Choose **Run full DNS benchmark** for a new test with 300 probes per provider. Click a provider's result indicator to see the details.

Results show median lookup time (typical response speed), 95th-percentile response time (slower responses), success rate, and response-time consistency. The checks use each provider's first IPv4 server, or its first IPv6 server when no IPv4 server is configured. Results can vary by network and location, so use the full benchmark for a larger sample.

DNS checks use `dig` to send DNS queries. If `dig` is unavailable and `ping` is installed, DNS Changer can use ping instead. Ping measures the network response to the server address, not the time taken to resolve a DNS query.

## Regional DNS presets

The panel menu can add regional providers to your list:

- **Iran:** Electro, Bagzar, Shekan, and 403.
- **Russia:** Yandex DNS Basic, Safe, and Family, plus MSK-IX Public DNS.

These presets are saved as custom providers and can be removed in Preferences. The 403 addresses are private-network addresses and work only on supported domestic Iranian networks. Provider availability and performance depend on your network.

## Using DNS Changer

1. Open **DNS Changer** from the GNOME top panel.
2. Select a provider to apply it to your active connection. To add your own servers, open Preferences and choose **Add a custom provider**.
3. To undo a change, choose **Restore original DNS for this connection** from the panel menu.

## Compatibility and network behavior

DNS Changer supports GNOME Shell versions 45–51 and connections managed by NetworkManager. Applying or restoring DNS settings restarts NetworkManager so the change takes effect. Your network connection may briefly disconnect and reconnect, and your desktop may ask you to authorize the change.

## License

DNS Changer is free and open-source software licensed under GPL-2.0-or-later. See [LICENSE](LICENSE).

## Contributing

For build, demo, and contribution instructions, see [CONTRIBUTING.md](CONTRIBUTING.md).
