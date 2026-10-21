"""CPU-only, dependency-free checks for the production Qwen hint fallback."""

import sys
import types
import unittest
from pathlib import Path

# Model inference is replaced below; importing the worker must not require a
# local CUDA/PyTorch/numpy installation to test pure guard and protocol logic.
sys.modules["numpy"] = types.ModuleType("numpy")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from local_stt.server import Qwen3AsrBackend, is_context_echo, normalize_context


CONTEXT = "技术面试词汇：Demo App、浅拷贝、宏任务、竞态、背压、事务、脏读、幻读、B+树、SIGTERM、systemd、CER、WER、P95、请求会话、iframe、服务模块。"


class FakeBackend(Qwen3AsrBackend):
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def _transcribe_once(self, pcm, sample_rate, language, *, context="", max_new_tokens=256):
        self.calls.append((pcm, sample_rate, language, context, max_new_tokens))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


class ContextChecks(unittest.TestCase):
    def test_bounded_context(self):
        self.assertEqual(len(normalize_context("词" * 1000)), 128)
        self.assertEqual(normalize_context({"not": "text"}), "")

    def test_normal_technical_question_is_not_echo(self):
        self.assertFalse(is_context_echo("Demo App 的请求会话需要实现哪四个方法？", CONTEXT, 4))
        self.assertFalse(is_context_echo("浅拷贝和深拷贝有什么区别？", CONTEXT, 3))

    def test_context_recital_is_suspicious(self):
        self.assertTrue(is_context_echo(CONTEXT, CONTEXT, 4))
        self.assertTrue(is_context_echo("、".join(CONTEXT.split("：")[1:] * 4), CONTEXT, 4))

    def test_short_complete_lists_are_suspicious_without_minimum_length(self):
        self.assertTrue(is_context_echo("闭包、竞态、背压", "技术面试词汇：闭包、竞态、背压。", 4))
        self.assertTrue(is_context_echo("技术面试词汇：闭包。", "技术面试词汇：闭包。", 4))
        self.assertFalse(is_context_echo("闭包是什么？", "技术面试词汇：闭包、竞态、背压。", 4))

    def test_normal_hint_used_once(self):
        backend = FakeBackend(["浅拷贝和深拷贝有什么区别？"])
        self.assertEqual(backend.transcribe(b"x" * 32000, 16000, "zh", context=CONTEXT),
                         "浅拷贝和深拷贝有什么区别？")
        self.assertEqual(len(backend.calls), 1)
        self.assertTrue(backend.last_diagnostics["hintApplied"])
        self.assertFalse(backend.last_diagnostics["hintFallback"])

    def test_echo_retries_same_pcm_without_hints_only_once(self):
        pcm = b"x" * 32000
        backend = FakeBackend([CONTEXT, "正确语音文字"])
        self.assertEqual(backend.transcribe(pcm, 16000, "zh", context=CONTEXT), "正确语音文字")
        self.assertEqual([call[0] for call in backend.calls], [pcm, pcm])
        self.assertEqual([call[3] for call in backend.calls], [CONTEXT, ""])
        self.assertTrue(backend.last_diagnostics["hintFallback"])
        self.assertEqual(backend.last_diagnostics["hintFallbackReason"], "echo")
        self.assertNotIn("context", backend.last_diagnostics)

    def test_empty_hint_result_retries_original_audio(self):
        backend = FakeBackend(["", "恢复识别"])
        self.assertEqual(backend.transcribe(b"xx", 16000, "zh", context=CONTEXT), "恢复识别")
        self.assertEqual(backend.last_diagnostics["hintFallbackReason"], "empty")

    def test_unsupported_prompt_recovers_without_hints(self):
        backend = FakeBackend([TypeError("unexpected keyword argument 'prompt'"), "兼容结果", "后续结果"])
        self.assertEqual(backend.transcribe(b"xx", 16000, "zh", context=CONTEXT), "兼容结果")
        self.assertEqual(backend.last_diagnostics["hintFallbackReason"], "context_error")
        self.assertEqual(backend.transcribe(b"xx", 16000, "zh", context=CONTEXT), "后续结果")
        self.assertEqual(len(backend.calls), 3)
        self.assertEqual(backend.calls[-1][3], "")
        self.assertFalse(backend.last_diagnostics["hintApplied"])

    def test_unrelated_model_type_error_is_not_hidden(self):
        backend = FakeBackend([TypeError("model has invalid input")])
        with self.assertRaises(TypeError):
            backend.transcribe(b"xx", 16000, "zh", context=CONTEXT)
        self.assertEqual(len(backend.calls), 1)

    def test_disabled_and_non_chinese_requests_stay_unhinted(self):
        for language in ("zh", "en-US"):
            backend = FakeBackend(["plain"])
            context = CONTEXT if language == "en-US" else ""
            self.assertEqual(backend.transcribe(b"xx", 16000, language, context=context), "plain")
            self.assertEqual(backend.calls[0][3], "")
            self.assertFalse(backend.last_diagnostics["hintApplied"])

    def test_unhinted_errors_and_second_failure_are_not_swallowed(self):
        for responses, context in (([TypeError("plain failure")], ""),
                                   ([CONTEXT, RuntimeError("fallback failure")], CONTEXT)):
            backend = FakeBackend(responses)
            with self.assertRaises((TypeError, RuntimeError)):
                backend.transcribe(b"xx", 16000, "zh", context=context)

    def test_invalid_sample_rate_is_rejected_before_model(self):
        backend = FakeBackend([])
        with self.assertRaises(ValueError):
            backend.transcribe(b"xx", 8000, "zh", context=CONTEXT)
        self.assertEqual(backend.calls, [])


if __name__ == "__main__":
    unittest.main()
