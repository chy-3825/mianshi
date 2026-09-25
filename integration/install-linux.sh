#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${HOME}/.local/bin"
unit_dir="${HOME}/.config/systemd/user"
desktop_dir="${HOME}/.local/share/applications"

install -d -m 0755 "$bin_dir" "$unit_dir" "$desktop_dir"
install -m 0755 "$script_dir/clash-verge-lifecycle-guard" \
  "$bin_dir/clash-verge-lifecycle-guard"
install -m 0755 "$script_dir/start-ai-stack.sh" "$bin_dir/start-ai-stack"
install -m 0644 "$script_dir/clash-verge-lifecycle-guard.service" \
  "$unit_dir/clash-verge-lifecycle-guard.service"
install -m 0644 "$script_dir/Clash-Verge.desktop" \
  "$desktop_dir/Clash Verge.desktop"
install -m 0644 "$script_dir/clash-verge-handler.desktop" \
  "$desktop_dir/clash-verge-handler.desktop"

systemctl --user daemon-reload
update-desktop-database "$desktop_dir" >/dev/null 2>&1 || true

printf '%s\n' \
  'Integration installed.' \
  'Enable the guard with:' \
  '  systemctl --user enable --now clash-verge-lifecycle-guard.service' \
  'Start the complete stack with:' \
  '  ~/.local/bin/start-ai-stack'

