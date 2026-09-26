#!/usr/bin/env bash
# Build the current local CCS checkout, then replace only the user-level CCS.
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_dir="$(cd -- "$script_dir/../.." && pwd -P)"
install_dir="${HOME}/.local/bin"
launcher="$install_dir/cc-switch"
current_link="$install_dir/cc-switch-current"
backup_root="${HOME}/.local/share/cc-switch-backups"
backup_dir=""
staged_binary=""
staged_launcher=""
staged_link=""
old_stopped=0
cutover_started=0
completed=0
new_pid=""
old_pid=""
old_ticks=""
old_exe=""

say() { printf '%s\n' "$*"; }
fail() { printf '更新失败：%s\n' "$*" >&2; exit 1; }

pid_ticks() {
  local stat_line rest
  IFS= read -r stat_line < "/proc/$1/stat" || return 1
  rest="${stat_line##*) }"
  # /proc/PID/stat field 22 becomes field 20 after removing pid + comm.
  awk '{ print $20 }' <<< "$rest"
}

same_process() {
  local actual_exe
  [[ -n "$old_pid" && -d "/proc/$old_pid" ]] || return 1
  [[ "$(pid_ticks "$old_pid" 2>/dev/null || true)" == "$old_ticks" ]] || return 1
  actual_exe="$(readlink -f -- "/proc/$old_pid/exe" 2>/dev/null || true)"
  [[ "$actual_exe" == "$old_exe" ]]
}

codex_is_running() {
  local proc comm owner
  for proc in /proc/[0-9]*; do
    [[ -r "$proc/comm" ]] || continue
    owner="$(stat -c %u -- "$proc" 2>/dev/null || true)"
    [[ "$owner" == "$(id -u)" ]] || continue
    IFS= read -r comm < "$proc/comm" || continue
    case "$comm" in
      codex|Codex|codex-code-mode|codex-linux-san*) return 0 ;;
    esac
  done
  return 1
}

find_running_ccs() {
  local proc exe owner ticks found=0
  old_pid=""
  old_ticks=""
  old_exe=""
  for proc in /proc/[0-9]*; do
    owner="$(stat -c %u -- "$proc" 2>/dev/null || true)"
    [[ "$owner" == "$(id -u)" ]] || continue
    exe="$(readlink -f -- "$proc/exe" 2>/dev/null || true)"
    case "$exe" in
      "$install_dir"/cc-switch-fixed-*|"$install_dir"/cc-switch-standalone-*|/usr/bin/cc-switch)
        ((found += 1))
        old_pid="${proc##*/}"
        old_exe="$exe"
        ticks="$(pid_ticks "$old_pid" 2>/dev/null || true)"
        [[ -n "$ticks" ]] || fail "无法核对 CCS 进程身份。"
        old_ticks="$ticks"
        ;;
    esac
  done
  ((found <= 1)) || fail "发现多个 CCS 进程，请先正常退出多余实例。"
}

find_live_database() {
  local fd path
  if [[ -n "$old_pid" ]]; then
    for fd in "/proc/$old_pid/fd/"*; do
      path="$(readlink -- "$fd" 2>/dev/null || true)"
      case "$path" in
        */cc-switch.db) printf '%s\n' "$path"; return 0 ;;
      esac
    done
  fi
  python3 - <<'PY'
import json
import os
from pathlib import Path

home = Path.home()
stores = (
    home / ".local/share/com.ccswitch.desktop/app_paths.json",
    home / ".config/com.ccswitch.desktop/app_paths.json",
    home / ".cc-switch/app_paths.json",
)
for store in stores:
    try:
        override = json.loads(store.read_text()).get("app_config_dir_override")
    except (OSError, ValueError, AttributeError):
        continue
    if isinstance(override, str) and override.strip():
        db = Path(os.path.expanduser(override.strip())) / "cc-switch.db"
        if db.is_file():
            print(db)
            break
else:
    print(home / ".cc-switch/cc-switch.db")
PY
}

backup_database() {
  local db_path="$1" destination="$2"
  [[ -f "$db_path" ]] || fail "未找到当前 CCS 数据库：$db_path；为防止丢失配置，已停止更新。"
  python3 - "$db_path" "$destination" <<'PY'
import os
import sqlite3
import sys
from urllib.parse import quote

source, target = sys.argv[1:]
uri = "file:" + quote(os.path.abspath(source), safe="/") + "?mode=ro"
src = sqlite3.connect(uri, uri=True, timeout=30)
dst = sqlite3.connect(target, timeout=30)
try:
    src.backup(dst)
finally:
    dst.close()
    src.close()
os.chmod(target, 0o600)
PY
}

install_from_backup() {
  local name="$1" destination="$2" temp
  if [[ -e "$backup_dir/$name" || -L "$backup_dir/$name" ]]; then
    temp="$(mktemp "$install_dir/.cc-switch-restore.XXXXXXXX")"
    rm -f -- "$temp"
    cp -a -- "$backup_dir/$name" "$temp"
    mv -fT -- "$temp" "$destination"
  else
    rm -f -- "$destination"
  fi
}

launch_ccs() {
  local log_file="$1"
  nohup "$launcher" > "$log_file" 2>&1 < /dev/null &
  new_pid=$!
}

stop_failed_new_ccs() {
  local exe
  [[ -n "$new_pid" && -d "/proc/$new_pid" ]] || return 0
  exe="$(readlink -f -- "/proc/$new_pid/exe" 2>/dev/null || true)"
  [[ "$exe" == "$new_binary" ]] || return 0
  kill -TERM "$new_pid" 2>/dev/null || true
  for _ in {1..50}; do
    [[ -d "/proc/$new_pid" ]] || return 0
    sleep 0.1
  done
  say "新 CCS 未及时退出，请先关闭 PID $new_pid 再使用旧版本。" >&2
  return 1
}

on_exit() {
  local code="$1" can_relaunch=1
  trap - EXIT
  set +e
  [[ -z "$staged_binary" ]] || rm -f -- "$staged_binary"
  [[ -z "$staged_launcher" ]] || rm -f -- "$staged_launcher"
  [[ -z "$staged_link" ]] || rm -f -- "$staged_link"
  if ((code != 0 && completed == 0)); then
    stop_failed_new_ccs || can_relaunch=0
    if ((cutover_started == 1)); then
      install_from_backup launcher "$launcher"
      install_from_backup current-link "$current_link"
      say "已恢复原来的 CCS 启动文件。" >&2
    fi
    if ((old_stopped == 1 && can_relaunch == 1)) && [[ -x "$launcher" ]]; then
      launch_ccs "$backup_dir/rollback-start.log"
      say "已尝试重新启动旧 CCS。" >&2
    fi
    [[ -z "$backup_dir" ]] || say "备份保留在：$backup_dir" >&2
  fi
  exit "$code"
}
trap 'on_exit $?' EXIT

[[ "$(id -u)" != 0 ]] || fail "请以当前桌面用户运行，不能用 sudo。"
[[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] || fail "没有图形桌面环境，请从桌面会话运行。"
export PATH="${HOME}/.cargo/bin:${HOME}/.local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for node_dir in "${HOME}"/.openclaw/tools/node-v*/bin; do
    if [[ -x "$node_dir/node" ]]; then
      export PATH="$node_dir:$PATH"
      break
    fi
  done
fi
for required in node pnpm cargo python3 sha256sum mktemp flock; do
  command -v "$required" >/dev/null 2>&1 || fail "缺少构建工具：$required"
done

mkdir -p -- "$backup_root" "$install_dir"
chmod 700 -- "$backup_root"
exec 9> "$backup_root/.update.lock"
flock -n 9 || fail "另一个 CCS 更新任务正在运行。"

codex_is_running && fail "检测到 Codex 正在运行。请先退出 Codex，避免更新时中断会话。"
find_running_ccs

say "正在从本地源码构建 CCS：$project_dir"
cd -- "$project_dir"
pnpm install --frozen-lockfile

if [[ -z "${CARGO_TARGET_DIR:-}" ]]; then
  old_target="${HOME}/桌面/cc-switch-修复版/src-tauri/target"
  if [[ -d "$old_target" ]]; then
    export CARGO_TARGET_DIR="$old_target"
  else
    export CARGO_TARGET_DIR="$project_dir/src-tauri/target"
  fi
elif [[ "$CARGO_TARGET_DIR" != /* ]]; then
  export CARGO_TARGET_DIR="$project_dir/$CARGO_TARGET_DIR"
fi
# Tauri must set its production build configuration. A plain cargo build
# keeps `cfg(dev)` and loads devUrl (localhost:3000), leaving the packaged
# window blank when no Vite server is running. The Tauri CLI also runs the
# configured renderer build before compiling Rust.
pnpm tauri build --no-bundle --ci
artifact="$CARGO_TARGET_DIR/release/cc-switch"
[[ -s "$artifact" && -x "$artifact" ]] || fail "构建结束但没有找到可执行文件：$artifact"

# A release executable must contain at least one of this renderer build's
# asset names. A direct Cargo build can succeed while keeping Tauri in dev
# mode, which otherwise opens an empty window at localhost:3000.
python3 - "$artifact" "$project_dir/dist/index.html" <<'PY'
from pathlib import Path
import re
import sys

binary = Path(sys.argv[1]).read_bytes()
html = Path(sys.argv[2]).read_text()
assets = re.findall(r"assets/[A-Za-z0-9_-]+\.js", html)
if not assets or not any(asset.encode() in binary for asset in assets):
    sys.exit("构建产物未包含前端资源，停止安装。请使用 Tauri 正式构建。")
PY

# Recheck immediately before the only disruptive part of this script.
codex_is_running && fail "构建期间 Codex 已启动。请退出 Codex 后重试更新。"
find_running_ccs
if [[ -n "$old_pid" ]]; then
  same_process || fail "CCS 进程已变化，请重试。"
fi

stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$(mktemp -d "$backup_root/update-$stamp.XXXXXXXX")"
chmod 700 -- "$backup_dir"
if [[ -e "$launcher" || -L "$launcher" ]]; then cp -a -- "$launcher" "$backup_dir/launcher"; fi
if [[ -e "$current_link" || -L "$current_link" ]]; then cp -a -- "$current_link" "$backup_dir/current-link"; fi
if [[ -n "$old_exe" && -f "$old_exe" ]]; then
  cp -p -- "$old_exe" "$backup_dir/previous-cc-switch"
elif [[ -e "$current_link" ]]; then
  cp -Lp -- "$current_link" "$backup_dir/previous-cc-switch"
elif [[ -f "$install_dir/cc-switch-fixed-3.20.3" ]]; then
  cp -p -- "$install_dir/cc-switch-fixed-3.20.3" "$backup_dir/previous-cc-switch"
fi

db_path="$(find_live_database)"
backup_database "$db_path" "$backup_dir/cc-switch.db"
if [[ -f "${db_path%/*}/settings.json" ]]; then
  cp -p -- "${db_path%/*}/settings.json" "$backup_dir/settings.json"
fi
say "已备份旧程序和 SQLite 数据库：$backup_dir"

binary_hash="$(sha256sum "$artifact" | awk '{ print $1 }')"
new_binary="$install_dir/cc-switch-standalone-${binary_hash:0:16}"
if [[ ! -e "$new_binary" ]]; then
  staged_binary="$(mktemp "$install_dir/.cc-switch-binary.XXXXXXXX")"
  cp -- "$artifact" "$staged_binary"
  chmod 755 -- "$staged_binary"
  mv -fT -- "$staged_binary" "$new_binary"
  staged_binary=""
elif [[ "$(sha256sum "$new_binary" | awk '{ print $1 }')" != "$binary_hash" ]]; then
  fail "目标文件已存在但校验值不同：$new_binary"
fi

if [[ -n "$old_pid" ]] && same_process; then
  codex_is_running && fail "备份期间 Codex 已启动。请退出 Codex 后重试更新。"
  say "正在正常退出旧 CCS（PID $old_pid）..."
  kill -TERM "$old_pid"
  for _ in {1..100}; do
    same_process || break
    sleep 0.1
  done
  same_process && fail "旧 CCS 未能在 10 秒内退出；未执行替换。"
  old_stopped=1
  # Keep the snapshot as close as possible to the final, closed database state.
  backup_database "$db_path" "$backup_dir/cc-switch.db"
  if [[ -f "${db_path%/*}/settings.json" ]]; then
    cp -p -- "${db_path%/*}/settings.json" "$backup_dir/settings.json"
  fi
fi

staged_link="$(mktemp "$install_dir/.cc-switch-link.XXXXXXXX")"
rm -f -- "$staged_link"
ln -s -- "${new_binary##*/}" "$staged_link"
cutover_started=1
mv -fT -- "$staged_link" "$current_link"
staged_link=""

staged_launcher="$(mktemp "$install_dir/.cc-switch-launcher.XXXXXXXX")"
cp -- "$script_dir/cc-switch-standalone" "$staged_launcher"
chmod 755 -- "$staged_launcher"
mv -fT -- "$staged_launcher" "$launcher"
staged_launcher=""

say "正在启动新 CCS..."
launch_ccs "$backup_dir/new-start.log"
for _ in {1..50}; do
  [[ -d "/proc/$new_pid" ]] || fail "新 CCS 启动后立即退出。"
  sleep 0.1
done
[[ "$(readlink -f -- "/proc/$new_pid/exe" 2>/dev/null || true)" == "$new_binary" ]] || fail "新 CCS 未保持运行。"

completed=1
say "更新完成。当前程序：$new_binary"
say "旧版本及数据库备份：$backup_dir"
