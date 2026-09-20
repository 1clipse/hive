"""Execute a bounded Jev Ultrafast browser task in one owned Chrome tab."""

from __future__ import annotations

import json
import os
import pathlib
import sys
from urllib.parse import urlparse


repo_path = os.environ.get("HIVE_JEV_ULTRAFAST_PATH")
if repo_path:
    sys.path.insert(0, repo_path)

from jev_ultrafast import Agent  # noqa: E402
from jev_ultrafast.browser import StalePage  # noqa: E402


SENSITIVE_TERMS = (
    "account", "authorize", "book", "buy", "checkout", "confirm", "delete", "download",
    "install", "log in", "login", "order", "password", "pay", "post", "publish",
    "purchase", "register", "remove", "reserve", "send", "sign in", "sign up", "submit",
    "transfer", "upload", "付款", "付费", "下单", "传送", "删除", "发布", "注册", "登录",
    "确认", "密码", "授权", "上传", "提交", "购买", "预订",
)


def origin(url: str) -> str:
    parsed = urlparse(url)
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}"


def action_policy(action: dict) -> tuple[bool, str]:
    text = " ".join(str(action.get(key, "")) for key in ("label", "role", "kind", "type")).lower()
    if action.get("type") in {"password", "file"} or action.get("role") == "password":
        return False, "credential_or_upload"
    if any(term in text for term in SENSITIVE_TERMS):
        return False, "sensitive_browser_action"
    return action.get("kind") in {"click", "fill", "select", "scroll", "wait"}, "low_risk_browser_action"


def contains(value: str, expected: str | None) -> bool:
    return expected is None or expected.casefold() in value.casefold()


def main() -> int:
    if os.environ.get("HIVE_JEV_BROWSER_EXECUTION") != "1":
        raise RuntimeError("Browser execution was not explicitly enabled.")
    if not os.environ.get("TYPESAFE_API_KEY"):
        raise RuntimeError("TYPESAFE_API_KEY is required; no browser action was executed.")

    payload = json.load(sys.stdin)
    allowed_origins = set(payload["allowed_origins"])
    max_actions = max(1, min(int(payload.get("max_actions", 12)), 12))
    actions = []

    with Agent(payload["url"], payload["goal"], screenshots=False) as agent:
        while agent.state["status"] not in {"done", "blocked"} and len(actions) < max_actions:
            page = agent.state["page"]
            if origin(page["url"]) not in allowed_origins:
                result = {
                    "accepted": False,
                    "status": "needs_confirmation",
                    "reason": "origin_not_allowed",
                    "pending_origin": origin(page["url"]),
                    "actions": actions,
                }
                json.dump(result, sys.stdout, ensure_ascii=True)
                return 0

            try:
                predicted = agent.command("predict")
                decision = predicted["decision"]
                predicted_page = predicted["page"]
                if decision["choice"] in {"DONE", "BLOCKED"}:
                    agent.command("act", {"fingerprint": predicted_page["fingerprint"]})
                    continue

                action = next(item for item in predicted_page["actions"] if item["id"] == decision["choice"])
                allowed, reason = action_policy(action)
                if not allowed:
                    result = {
                        "accepted": False,
                        "status": "needs_confirmation",
                        "reason": reason,
                        "pending_action": {
                            "kind": action.get("kind"),
                            "label": action.get("label"),
                            "url": predicted_page["url"],
                        },
                        "actions": actions,
                    }
                    json.dump(result, sys.stdout, ensure_ascii=True)
                    return 0

                agent.command("act", {"fingerprint": predicted_page["fingerprint"]})
            except StalePage:
                agent.state["decision"] = None
                agent.state["status"] = "ready"
                agent.state["page"] = agent.browser.observe(screenshot=False)
                continue
            actions.append({
                "kind": action.get("kind"),
                "label": action.get("label"),
                "url": agent.state["page"]["url"],
                "jev_latency_ms": decision.get("latency_ms"),
                "text_model": agent.state["history"][-1].get("text_helper"),
                "auto_approved": True,
            })

        page = agent.state["page"]
        checks = {
            "url": contains(page["url"], payload.get("expect_url_contains")),
            "title": contains(page["title"], payload.get("expect_title_contains")),
            "text": contains(page["text"], payload.get("expect_text_contains")),
        }
        accepted = agent.state["status"] == "done" and all(checks.values())
        json.dump({
            "accepted": accepted,
            "status": agent.state["status"] if len(actions) < max_actions else "action_budget_exhausted",
            "final_url": page["url"],
            "final_title": page["title"],
            "expectations": checks,
            "actions": actions,
            "text_model": os.environ.get("TEXT_MODEL", "deepseek-flash"),
        }, sys.stdout, ensure_ascii=True)
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1) from None
