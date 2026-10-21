#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
venv_dir="$project_dir/.venv-stt"
engine="qwen3-asr"
print_target=false

usage() {
  echo "用法: $0 [--user-install | --target 绝对路径] [--engine qwen3-asr|sensevoice|whisper] [--print-target]"
  echo "  源码运行默认安装到项目 .venv-stt；AppImage 用户请用 --user-install。"
}

while (($#)); do
  case "$1" in
    --user-install)
      data_home="${XDG_DATA_HOME:-}"
      if [[ -z "$data_home" || "$data_home" != /* ]]; then
        data_home="$HOME/.local/share"
      fi
      venv_dir="$data_home/interview-copilot/stt-venv"
      shift
      ;;
    --target)
      if (($# < 2)) || [[ "$2" != /* ]]; then
        echo "--target 需要绝对路径" >&2
        exit 2
      fi
      venv_dir="$2"
      shift 2
      ;;
    --engine)
      if (($# < 2)) || [[ "$2" != "qwen3-asr" && "$2" != "sensevoice" && "$2" != "whisper" ]]; then
        echo "--engine 只能是 qwen3-asr、sensevoice 或 whisper" >&2
        exit 2
      fi
      engine="$2"
      shift 2
      ;;
    --print-target)
      print_target=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if $print_target; then
  printf '%s\n' "$venv_dir"
  exit 0
fi

requirements="$project_dir/local_stt/requirements-$engine.txt"
if [[ ! -f "$requirements" ]]; then
  echo "找不到 $requirements；请从完整的 Linux 语音安装包或源码目录运行此脚本。" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "未安装 python3；请先安装 Python 3 和 python3-venv。" >&2
  exit 1
fi

umask 077
python3 -m venv "$venv_dir"
"$venv_dir/bin/python" -m pip install --upgrade pip
if [[ "$engine" == "sensevoice" || "$engine" == "qwen3-asr" ]]; then
  "$venv_dir/bin/pip" install -r "$requirements" \
    --extra-index-url https://download.pytorch.org/whl/cu128
else
  "$venv_dir/bin/pip" install -r "$requirements"
fi

if [[ "$engine" == "qwen3-asr" ]]; then
  echo "正在缓存 Qwen3-ASR 0.6B 模型（约 1.6 GB）；首次下载可能需要较长时间。"
  "$venv_dir/bin/python" -c 'from huggingface_hub import snapshot_download; snapshot_download("Qwen/Qwen3-ASR-0.6B-hf")'
fi

echo "本地语音环境安装完成：$venv_dir"
if [[ "$engine" != "qwen3-asr" ]]; then
  echo "首次识别时会下载所选语音模型；请保持网络连接并留出足够磁盘空间。"
fi
