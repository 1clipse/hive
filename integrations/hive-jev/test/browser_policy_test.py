"""Pure policy tests for the executable browser runner."""

import importlib.util
import pathlib
import unittest


RUNNER = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "browser-run.py"
SPEC = importlib.util.spec_from_file_location("hive_jev_browser_runner", RUNNER)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BrowserPolicyTest(unittest.TestCase):
    def test_allows_search(self):
        self.assertEqual(MODULE.action_policy({"kind": "click", "label": "Search"}), (True, "low_risk_browser_action"))

    def test_blocks_sensitive_click(self):
        self.assertEqual(MODULE.action_policy({"kind": "click", "label": "Delete account"}), (False, "sensitive_browser_action"))

    def test_blocks_password_and_upload(self):
        self.assertEqual(MODULE.action_policy({"kind": "fill", "role": "password"}), (False, "credential_or_upload"))
        self.assertEqual(MODULE.action_policy({"kind": "fill", "type": "file"}), (False, "credential_or_upload"))


if __name__ == "__main__":
    unittest.main()
