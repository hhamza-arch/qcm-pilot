"""Backend tests. Run from the backend folder:

    pip install httpx
    python -m unittest -v
"""

import json
import os
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from openai import AuthenticationError, RateLimitError

import main

VALID = {
    "question": "What is the capital of France?",
    "options": ["Berlin", "Paris", "Madrid"],
    "multiple": False,
}

GOOD_JSON = json.dumps(
    {"answer_indexes": [2], "explanation": "Paris is the capital.", "confidence": "High", "caution": ""}
)


def _status_error(cls, status):
    request = httpx.Request("POST", "http://test")
    response = httpx.Response(status, request=request)
    return cls("error", response=response, body=None)


class BackendTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(
            os.environ,
            {"AI_PROVIDER": "gemini", "GEMINI_API_KEY": "test-key", "MAX_RETRIES": "2"},
        )
        env.start()
        self.addCleanup(env.stop)
        sleep = patch.object(main, "_sleep", lambda _s: None)
        sleep.start()
        self.addCleanup(sleep.stop)
        self.client = TestClient(main.app)

    def test_health(self):
        body = self.client.get("/health").json()
        self.assertEqual(body["status"], "ok")
        self.assertTrue(body["configured"])
        self.assertNotIn("test-key", json.dumps(body))

    def test_invalid_input(self):
        for payload in (
            {"question": "ab", "options": ["a", "b"]},
            {"question": "Valid question?", "options": ["only one"]},
            {"question": "Valid question?", "options": ["a", "   "]},
            {"options": ["a", "b"]},
        ):
            response = self.client.post("/analyze", json=payload)
            self.assertEqual(response.status_code, 422, payload)
            self.assertIn("Invalid input", response.json()["detail"])

    def test_success(self):
        with patch.object(main, "run_provider", return_value=GOOD_JSON):
            response = self.client.post("/analyze", json=VALID)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["answer"], "Option B")
        self.assertEqual(body["choice_text"], "Paris")
        self.assertEqual(body["confidence"], "High")
        self.assertEqual(body["caution"], "")

    def test_fenced_json_and_multiple(self):
        text = '```json\n{"answer_indexes":[1,3],"explanation":"x","confidence":"medium","caution":"c"}\n```'
        payload = dict(VALID, multiple=True)
        with patch.object(main, "run_provider", return_value=text):
            body = self.client.post("/analyze", json=payload).json()
        self.assertEqual(body["answer"], "Option A, Option C")
        self.assertEqual(body["confidence"], "Medium")

    def test_single_question_trims_extra_answers(self):
        text = json.dumps({"answer_indexes": [1, 2], "explanation": "x", "confidence": "High", "caution": ""})
        with patch.object(main, "run_provider", return_value=text):
            body = self.client.post("/analyze", json=VALID).json()
        self.assertEqual(body["answer_indexes"], [1])
        self.assertIn("only the first", body["caution"])

    def test_retry_then_success(self):
        calls = {"n": 0}

        def flaky(*_args):
            calls["n"] += 1
            if calls["n"] < 3:
                raise _status_error(RateLimitError, 429)
            return GOOD_JSON

        with patch.object(main, "run_provider", side_effect=flaky):
            response = self.client.post("/analyze", json=VALID)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls["n"], 3)

    def test_rate_limit_gives_429_after_retries(self):
        with patch.object(main, "run_provider", side_effect=_status_error(RateLimitError, 429)):
            response = self.client.post("/analyze", json=VALID)
        self.assertEqual(response.status_code, 429)

    def test_auth_error_not_retried_and_no_key_leak(self):
        with patch.object(main, "run_provider", side_effect=_status_error(AuthenticationError, 401)) as mocked:
            response = self.client.post("/analyze", json=VALID)
        self.assertEqual(response.status_code, 502)
        self.assertEqual(mocked.call_count, 1)
        self.assertNotIn("test-key", response.text)

    def test_unreadable_model_output(self):
        with patch.object(main, "run_provider", return_value="not json at all"):
            response = self.client.post("/analyze", json=VALID)
        self.assertEqual(response.status_code, 502)

    def test_out_of_range_answer_rejected(self):
        text = json.dumps({"answer_indexes": [9], "explanation": "x", "confidence": "High", "caution": ""})
        with patch.object(main, "run_provider", return_value=text):
            response = self.client.post("/analyze", json=VALID)
        self.assertEqual(response.status_code, 502)

    def test_missing_api_key(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            response = self.client.post("/analyze", json=VALID)
        self.assertEqual(response.status_code, 503)
        self.assertIn("GEMINI_API_KEY", response.json()["detail"])

    def test_invalid_provider(self):
        with patch.dict(os.environ, {"AI_PROVIDER": "banana"}):
            self.assertEqual(self.client.post("/analyze", json=VALID).status_code, 503)

    def test_openai_provider_uses_responses_api_with_store_false(self):
        captured = {}

        class FakeResponses:
            def create(self, **kwargs):
                captured.update(kwargs)

                class R:
                    output_text = GOOD_JSON

                return R()

        class FakeClient:
            responses = FakeResponses()

        cfg = main.Settings("openai", "k", "OPENAI_API_KEY", "gpt-test", None, 5.0, 0)
        text = main.run_provider(FakeClient(), cfg, main.AnalyzeRequest(**VALID))
        self.assertEqual(text, GOOD_JSON)
        self.assertIs(captured["store"], False)
        self.assertEqual(captured["text"]["format"]["type"], "json_schema")

    def test_cors(self):
        origin = "chrome-extension://" + "a" * 32
        ok = self.client.get("/health", headers={"Origin": origin})
        self.assertEqual(ok.headers.get("access-control-allow-origin"), origin)
        bad = self.client.get("/health", headers={"Origin": "https://evil.example"})
        self.assertIsNone(bad.headers.get("access-control-allow-origin"))

    # ---- batch endpoint (Practice Auto-Fill) ----
    BATCH = {
        "questions": [
            {"question": "Capital of France?", "options": ["Berlin", "Paris", "Madrid"], "multiple": False},
            {"question": "Pick the primes", "options": ["2", "4", "5"], "multiple": True},
        ]
    }

    def test_batch_success_single_ai_call(self):
        text = json.dumps({"answers": [
            {"q": 1, "answer_indexes": [2], "explanation": "Paris", "confidence": "High", "caution": ""},
            {"q": 2, "answer_indexes": [1, 3], "explanation": "2 and 5", "confidence": "Medium", "caution": ""},
        ]})
        with patch.object(main, "run_provider_batch", return_value=text) as mocked:
            response = self.client.post("/analyze-batch", json=self.BATCH)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(mocked.call_count, 1)
        results = response.json()["results"]
        self.assertEqual(results[0]["result"]["answer"], "Option B")
        self.assertEqual(results[1]["result"]["choice_text"], "2 | 5")

    def test_batch_partial_failure_is_reported_per_question(self):
        text = json.dumps({"answers": [
            {"q": 1, "answer_indexes": [2], "explanation": "Paris", "confidence": "High", "caution": ""},
            {"q": 2, "answer_indexes": [9], "explanation": "bad", "confidence": "High", "caution": ""},
        ]})
        with patch.object(main, "run_provider_batch", return_value=text):
            results = self.client.post("/analyze-batch", json=self.BATCH).json()["results"]
        self.assertIsNotNone(results[0]["result"])
        self.assertIsNone(results[1]["result"])
        self.assertTrue(results[1]["error"])

    def test_batch_missing_answer_and_garbage(self):
        only_first = json.dumps({"answers": [
            {"q": 1, "answer_indexes": [1], "explanation": "x", "confidence": "Low", "caution": ""}]})
        with patch.object(main, "run_provider_batch", return_value=only_first):
            results = self.client.post("/analyze-batch", json=self.BATCH).json()["results"]
        self.assertIn("did not answer", results[1]["error"])
        with patch.object(main, "run_provider_batch", return_value="nope"):
            self.assertEqual(self.client.post("/analyze-batch", json=self.BATCH).status_code, 502)

    def test_batch_validation_limits(self):
        self.assertEqual(self.client.post("/analyze-batch", json={"questions": []}).status_code, 422)
        too_many = {"questions": [self.BATCH["questions"][0]] * (main.MAX_BATCH + 1)}
        self.assertEqual(self.client.post("/analyze-batch", json=too_many).status_code, 422)

    def test_openai_batch_uses_strict_schema_and_store_false(self):
        captured = {}

        class FakeResponses:
            def create(self, **kwargs):
                captured.update(kwargs)

                class R:
                    output_text = "{}"

                return R()

        class FakeClient:
            responses = FakeResponses()

        cfg = main.Settings("openai", "k", "OPENAI_API_KEY", "gpt-test", None, 5.0, 0)
        reqs = [main.AnalyzeRequest(**q) for q in self.BATCH["questions"]]
        main.run_provider_batch(FakeClient(), cfg, reqs)
        self.assertIs(captured["store"], False)
        schema = captured["text"]["format"]["schema"]
        item = schema["properties"]["answers"]["items"]
        self.assertEqual(set(item["required"]), set(item["properties"]))  # strict mode needs this

    # ---- access token for online hosting ----
    def test_access_token_required_when_configured(self):
        with patch.dict(os.environ, {"ACCESS_TOKEN": "s3cret"}), \
             patch.object(main, "run_provider", return_value=GOOD_JSON):
            self.assertEqual(self.client.post("/analyze", json=VALID).status_code, 401)
            self.assertEqual(
                self.client.post("/analyze", json=VALID, headers={"X-Access-Token": "wrong"}).status_code, 401)
            ok = self.client.post("/analyze", json=VALID, headers={"X-Access-Token": "s3cret"})
            self.assertEqual(ok.status_code, 200)
            self.assertEqual(self.client.post("/analyze-batch", json=self.BATCH).status_code, 401)
            # health stays open so the badge works; it never returns the token
            self.assertNotIn("s3cret", self.client.get("/health").text)

    def test_cors_allows_token_header(self):
        origin = "chrome-extension://" + "a" * 32
        pre = self.client.options("/analyze", headers={
            "Origin": origin, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-access-token"})
        self.assertEqual(pre.status_code, 200)


if __name__ == "__main__":
    unittest.main()
