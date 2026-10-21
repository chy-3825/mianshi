#!/usr/bin/env python3
"""Persistent local speech-to-text worker using newline-delimited JSON over stdio."""

import base64
import io
import json
import math
import re
import sys
import time
import wave
import unicodedata

import numpy as np


MAX_CONTEXT_CHARS = 128


def normalize_context(context):
    if not isinstance(context, str):
        return ""
    return context[:MAX_CONTEXT_CHARS].strip()


def context_terms(context):
    body = context.split("：", 1)[-1]
    return [term.strip(" .。") for term in re.split(r"[、,，;；\n]", body) if term.strip(" .。")]


def compact_text(text):
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", text)).casefold()


def is_context_echo(text, context, audio_seconds):
    """Conservative suspicion only: rerun original audio without any hints."""
    if not context or not text:
        return False
    output = compact_text(text)
    terms = [compact_text(term) for term in context_terms(context)]
    terms = list(dict.fromkeys(term for term in terms if len(term) >= 2))
    if not terms:
        return False
    matched = [term for term in terms if term in output]
    term_body = "".join(terms)
    # A complete short list may be fewer than 40 characters. Check this
    # independently of the long-response heuristic; never delete its words,
    # only verify the original PCM with an unhinted decode.
    if len(terms) >= 2 and output in (term_body, compact_text(context)):
        return True
    if context.startswith("技术面试词汇：") and output == compact_text(context):
        return True
    if len(matched) >= max(6, math.ceil(len(terms) * 0.65)) and len(output) >= 40:
        # A near-complete vocabulary recital, or an abnormally long hinted
        # response, is not accepted without checking the same PCM again.
        if term_body in output or len(output) > max(80, audio_seconds * 24 + 24):
            return True
        covered = sum(len(term) for term in matched)
        if covered / max(1, len(output)) > 0.75:
            return True
    if len(output) > max(96, audio_seconds * 30 + 30) and len(matched) >= 4:
        return True
    if len(output) >= 64:
        chunks = [output[index : index + 12] for index in range(len(output) - 11)]
        if any(chunks.count(chunk) >= 5 for chunk in set(chunks)):
            return True
    return False


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def pcm_to_wav(pcm, sample_rate):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


def warm_pcm():
    """One second of deterministic, quiet synthetic audio, kept only in memory."""
    times = np.arange(16000, dtype=np.float32) / 16000
    audio = 0.015 * np.sin(2 * np.pi * 220 * times)
    return (audio * 32767).astype(np.int16).tobytes()


class SenseVoiceBackend:
    def __init__(self, model_name, device):
        from funasr import AutoModel

        self.model = AutoModel(
            model=model_name or "iic/SenseVoiceSmall",
            trust_remote_code=True,
            device=device,
            disable_update=True,
        )

    def transcribe(self, pcm, sample_rate, language):
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        lang = "zh" if language in ("zh", "zh-CN") else "auto"
        result = self.model.generate(input=audio, cache={}, language=lang, use_itn=True)
        text = result[0].get("text", "") if result else ""
        try:
            from funasr.utils.postprocess_utils import rich_transcription_postprocess

            text = rich_transcription_postprocess(text)
        except Exception:
            pass
        return text.strip()

    def warm(self):
        self.transcribe(warm_pcm(), 16000, "zh")


class FasterWhisperBackend:
    def __init__(self, model_name, device):
        from faster_whisper import WhisperModel

        compute_type = "float16" if device == "cuda" else "int8"
        self.model = WhisperModel(model_name or "large-v3-turbo", device=device, compute_type=compute_type)

    def transcribe(self, pcm, sample_rate, language, *, vad_filter=True):
        wav = pcm_to_wav(pcm, sample_rate)
        lang = None if language in ("multi", "auto") else language.split("-")[0]
        segments, _ = self.model.transcribe(
            io.BytesIO(wav), language=lang, beam_size=1, vad_filter=vad_filter, condition_on_previous_text=False
        )
        return "".join(segment.text for segment in segments).strip()

    def warm(self):
        # VAD could discard synthetic audio without exercising the ASR model.
        self.transcribe(warm_pcm(), 16000, "zh", vad_filter=False)


class Qwen3AsrBackend:
    def __init__(self, model_name, device):
        import torch
        from transformers import AutoProcessor, Qwen3ASRForConditionalGeneration

        self.torch = torch
        self.device = "cuda" if device == "cuda" else "cpu"
        self.dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
        self.context_supported = True
        model_id = model_name or "Qwen/Qwen3-ASR-0.6B-hf"
        self.processor = AutoProcessor.from_pretrained(model_id)
        self.model = (
            Qwen3ASRForConditionalGeneration.from_pretrained(model_id, dtype=self.dtype)
            .to(self.device)
            .eval()
        )

    def _transcribe_once(self, pcm, sample_rate, language, *, context="", max_new_tokens=256):
        if sample_rate != 16000:
            raise ValueError("Qwen3-ASR requires 16 kHz PCM")
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        lang = "zh" if language in ("zh", "zh-CN") else None
        options = {"prompt": context} if context else {}
        inputs = self.processor.apply_transcription_request(audio=audio, language=lang, **options).to(
            self.device, self.dtype
        )
        with self.torch.inference_mode():
            output_ids = self.model.generate(
                **inputs, max_new_tokens=max_new_tokens, do_sample=False, num_beams=3
            )
        generated_ids = output_ids[:, inputs["input_ids"].shape[1] :]
        return self.processor.decode(generated_ids, return_format="transcription_only")[0].strip()

    def transcribe(self, pcm, sample_rate, language, *, context="", max_new_tokens=256):
        if sample_rate != 16000:
            raise ValueError("Qwen3-ASR requires 16 kHz PCM")
        context = normalize_context(context) if language in ("zh", "zh-CN") else ""
        if not getattr(self, "context_supported", True):
            context = ""
        self.last_diagnostics = {
            "hintApplied": bool(context),
            "hintFallback": False,
            "hintChars": len(context),
            "hintTermCount": len(context_terms(context)) if context else 0,
        }
        try:
            text = self._transcribe_once(
                pcm, sample_rate, language, context=context, max_new_tokens=max_new_tokens
            )
        except TypeError as error:
            # Older compatible processors may not implement prompt yet. Do
            # not fail the whole live session or repeatedly try the same hint.
            if not context or not (
                "unexpected keyword argument" in str(error) and "prompt" in str(error)
            ):
                raise
            self.context_supported = False
            text = ""
            self.last_diagnostics["hintFallbackReason"] = "context_error"
        if context and (
            not text.strip() or is_context_echo(text, context, len(pcm) / 32000)
        ):
            self.last_diagnostics["hintFallback"] = True
            self.last_diagnostics.setdefault("hintFallbackReason", "empty" if not text.strip() else "echo")
            text = self._transcribe_once(
                pcm, sample_rate, language, context="", max_new_tokens=max_new_tokens
            )
        return text

    def warm(self):
        # Exercise feature extraction, encoder and beam decoder without a full-length response.
        self.transcribe(warm_pcm(), 16000, "zh", max_new_tokens=8)


def main():
    backend = None
    warm_ms = None
    for raw in sys.stdin:
        request = None
        try:
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            request_id = request.get("id")
            command = request.get("command")
            if command == "init":
                backend = None
                warm_ms = None
                engine = request.get("engine", "sensevoice")
                model = request.get("model", "")
                device = request.get("device", "cuda")
                if engine == "sensevoice":
                    backend = SenseVoiceBackend(model, device)
                elif engine in ("qwen3-asr", "qwen"):
                    backend = Qwen3AsrBackend(model, device)
                elif engine in ("faster-whisper", "whisper"):
                    backend = FasterWhisperBackend(model, device)
                else:
                    raise ValueError(f"unsupported local STT engine: {engine}")
                emit({"id": request_id, "ok": True, "ready": True, "engine": engine})
            elif command == "warm":
                if backend is None:
                    raise RuntimeError("local STT model is not initialized")
                if warm_ms is None:
                    started_at = time.perf_counter()
                    backend.warm()
                    warm_ms = (time.perf_counter() - started_at) * 1000
                emit({"id": request_id, "ok": True, "warmMs": warm_ms})
            elif command == "transcribe":
                if backend is None:
                    raise RuntimeError("local STT model is not initialized")
                encoded_pcm = request["pcm"]
                if not isinstance(encoded_pcm, str) or len(encoded_pcm) > 1_300_000:
                    raise ValueError("PCM audio must be at most 30 seconds at 16 kHz")
                pcm = base64.b64decode(encoded_pcm, validate=True)
                if len(pcm) % 2 or len(pcm) > 16000 * 2 * 30:
                    raise ValueError("invalid PCM audio size")
                started_at = time.perf_counter()
                options = {"context": request.get("context", "")} if isinstance(backend, Qwen3AsrBackend) else {}
                text = backend.transcribe(
                    pcm, int(request.get("sampleRate", 16000)), request.get("language", "zh"), **options
                )
                inference_ms = (time.perf_counter() - started_at) * 1000
                emit({"id": request_id, "ok": True, "text": text, "inferenceMs": inference_ms,
                      **(getattr(backend, "last_diagnostics", {}) if isinstance(backend, Qwen3AsrBackend) else {})})
            elif command == "shutdown":
                emit({"id": request_id, "ok": True})
                return
            else:
                raise ValueError(f"unknown command: {command}")
        except Exception as exc:
            emit({"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
