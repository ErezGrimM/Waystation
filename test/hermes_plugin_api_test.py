import json
import re
import sys
import types
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi import APIRouter, HTTPException
except ModuleNotFoundError:
    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            self.status_code = status_code
            self.detail = detail

    class APIRouter:
        def get(self, _path):
            return lambda function: function

    fastapi_stub = types.ModuleType("fastapi")
    fastapi_stub.APIRouter = APIRouter
    fastapi_stub.HTTPException = HTTPException
    sys.modules["fastapi"] = fastapi_stub

from integrations.hermes.dashboard import plugin_api


class FakeProcess:
    def __init__(self, stdout: bytes, stderr: bytes = b"", returncode: int = 0):
        self.stdout = BytesIO(stdout)
        self.stderr = BytesIO(stderr)
        self.returncode = returncode
        self.killed = False

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.killed = True


class HermesPluginApiTests(unittest.TestCase):
    def test_dashboard_name_matches_renderer_namespace(self):
        manifest_path = Path("integrations/hermes/dashboard/manifest.json")
        desktop_path = Path("integrations/hermes/desktop/plugin.js")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        desktop = desktop_path.read_text(encoding="utf-8")
        escaped_name = re.escape(manifest["name"])
        self.assertRegex(desktop, rf'export default \{{\s*id: "{escaped_name}"')
        self.assertEqual(manifest["api"], "plugin_api.py")

    def test_run_json_returns_data_with_bounded_output_capture(self):
        process = FakeProcess(b'{"ok":true,"data":[]}')
        with (
            patch.object(
                plugin_api,
                "_configuration",
                return_value=(Path("."), Path("."), Path("bun"), Path("cli")),
            ),
            patch.object(plugin_api.subprocess, "Popen", return_value=process),
        ):
            self.assertEqual(plugin_api._run_json("task list", ["task", "list"]), [])
        self.assertFalse(process.killed)

    def test_run_json_kills_reader_when_output_limit_is_crossed(self):
        process = FakeProcess(b"x" * 1025)
        with (
            patch.object(plugin_api, "_MAX_OUTPUT_BYTES", 1024),
            patch.object(
                plugin_api,
                "_configuration",
                return_value=(Path("."), Path("."), Path("bun"), Path("cli")),
            ),
            patch.object(plugin_api.subprocess, "Popen", return_value=process),
        ):
            with self.assertRaises(HTTPException) as error:
                plugin_api._run_json("task list", ["task", "list"])
        self.assertEqual(error.exception.status_code, 502)
        self.assertIn("output exceeds", error.exception.detail)
        self.assertTrue(process.killed)

    def test_task_id_validation_matches_waystation_record_ids(self):
        self.assertIsNotNone(plugin_api._TASK_ID_RE.fullmatch("task.alpha_1-z"))
        self.assertIsNone(plugin_api._TASK_ID_RE.fullmatch("task..alpha"))
        self.assertIsNone(plugin_api._TASK_ID_RE.fullmatch("../outside"))


if __name__ == "__main__":
    unittest.main()
