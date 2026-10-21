#!/usr/bin/env python3
"""Isolated Qwen3-ASR context experiment; production worker stays unchanged."""

import base64
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from local_stt.server import Qwen3AsrBackend, warm_pcm


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def transcribe_with_prompt(backend, pcm, prompt, language, max_new_tokens=256):
    # Identical audio normalization, dtype, beam count and generation budget to
    # Qwen3AsrBackend.transcribe; the system context is the single intervention.
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    lang = "zh" if language in ("zh", "zh-CN") else None
    inputs = backend.processor.apply_transcription_request(
        audio=audio, language=lang, prompt=prompt
    ).to(backend.device, backend.dtype)
    with backend.torch.inference_mode():
        output_ids = backend.model.generate(
            **inputs, max_new_tokens=max_new_tokens, do_sample=False, num_beams=3
        )
    generated_ids = output_ids[:, inputs["input_ids"].shape[1] :]
    return backend.processor.decode(generated_ids, return_format="transcription_only")[0].strip()


def main():
    backend = None
    prompt = None
    for raw in sys.stdin:
        request = None
        try:
            request = json.loads(raw)
            command = request.get("command")
            if command == "init":
                prompt = request["prompt"]
                if not isinstance(prompt, str) or not prompt.strip():
                    raise ValueError("fixed context must be nonempty")
                started = time.perf_counter()
                backend = Qwen3AsrBackend(request.get("model", ""), "cuda")
                backend.warm()
                transcribe_with_prompt(backend, warm_pcm(), prompt, "zh", max_new_tokens=8)
                emit({"id": request["id"], "ok": True, "warmupMs": (time.perf_counter() - started) * 1000})
            elif command == "transcribe":
                if backend is None:
                    raise RuntimeError("worker is not initialized")
                pcm = base64.b64decode(request["pcm"], validate=True)
                if len(pcm) % 2 or not pcm or len(pcm) > 16000 * 2 * 30:
                    raise ValueError("invalid PCM audio size")
                if request.get("sampleRate") != 16000:
                    raise ValueError("Qwen3-ASR requires 16 kHz PCM")
                condition = request["condition"]
                if condition not in ("none", "fixed-context"):
                    raise ValueError("unknown condition")
                # Synchronize only outside the measured inference to prevent a
                # preceding CUDA task from contaminating the condition timing.
                backend.torch.cuda.synchronize()
                started = time.perf_counter()
                if condition == "none":
                    text = backend.transcribe(pcm, 16000, request.get("language", "zh"))
                else:
                    text = transcribe_with_prompt(backend, pcm, prompt, request.get("language", "zh"))
                backend.torch.cuda.synchronize()
                elapsed = (time.perf_counter() - started) * 1000
                emit({
                    "id": request["id"], "ok": True, "text": text,
                    "inferenceMs": elapsed, "condition": condition,
                    "pcmSha256": hashlib.sha256(pcm).hexdigest(),
                })
            elif command == "shutdown":
                emit({"id": request["id"], "ok": True})
                return
            else:
                raise ValueError("unknown command")
        except Exception as error:
            # Avoid dumping paths, environment, model-loader output or settings.
            emit({
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False, "errorName": type(error).__name__,
            })


if __name__ == "__main__":
    main()
