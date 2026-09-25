# Integration

`start-ai-stack.sh` first starts Clash Verge, waits for its loopback mixed-port, and then starts CC Switch. This prevents CC Switch from attempting upstream requests before Clash is ready.

`clash-verge-lifecycle-guard` owns only Clash processes started through the supplied desktop entry. On exit it restores the previous GNOME proxy state and avoids killing unrelated Mihomo/Clash processes.

The user service continuously reconciles that lifecycle state. Install the files with `install-linux.sh`; no root permission is needed for the integration layer.

The system-level `clash-verge-service` itself is installed by Clash Verge Rev and is intentionally not duplicated here with a machine-specific user/group value.
