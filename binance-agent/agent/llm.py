"""Local LLM analyst (Ollama or any OpenAI-compatible server).

Design rules:
  * The LLM returns strict JSON; anything unparsable = no opinion (None).
  * The LLM can only *veto* entries or *reduce* risk on open trades
    (tighten / close). It can never widen a stop, size a trade, or
    open one on its own. Hallucinations therefore can't blow up the account.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

import requests

from .config import LLMCfg

log = logging.getLogger("llm")

ENTRY_SYSTEM = """You are a disciplined crypto swing trader and risk manager.
You receive a pre-screened LONG setup that passed a technical filter.
Your job is to find reasons NOT to take it: exhaustion, distribution, weak
volume, fake breakouts, overextension from EMAs, upcoming resistance.
Only approve high-quality, trend-aligned entries. Being flat is a valid position.
Respond ONLY with JSON:
{"decision": "BUY" | "SKIP", "confidence": 0.0-1.0,
 "reasons": ["..."], "risks": ["..."]}"""

REVIEW_SYSTEM = """You are a risk manager supervising an OPEN LONG crypto position.
Protect profits and capital. Decide:
  HOLD    - trend intact, let it run
  TIGHTEN - momentum fading, protect more profit (stop is raised by the system)
  CLOSE   - structure broken / high risk of reversal, exit now
You cannot widen stops. Prefer HOLD in healthy trends; do not panic on normal
pullbacks that stay above EMA21 with declining sell volume.
Respond ONLY with JSON:
{"action": "HOLD" | "TIGHTEN" | "CLOSE", "confidence": 0.0-1.0, "reason": "..."}"""


@dataclass
class EntryVerdict:
    buy: bool
    confidence: float
    reasons: list[str]
    risks: list[str]


@dataclass
class ReviewVerdict:
    action: str
    confidence: float
    reason: str


def _extract_json(text: str) -> dict | None:
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                return None
    return None


def _conf(v) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.0


class LocalLLM:
    def __init__(self, cfg: LLMCfg):
        self.cfg = cfg
        self.session = requests.Session()

    # ---- transport -------------------------------------------------------
    def chat(self, system: str, user: str) -> str | None:
        c = self.cfg
        try:
            if c.provider == "ollama":
                r = self.session.post(f"{c.base_url.rstrip('/')}/api/chat", timeout=c.timeout_sec, json={
                    "model": c.model, "stream": False, "format": "json",
                    "options": {"temperature": c.temperature},
                    "messages": [{"role": "system", "content": system},
                                 {"role": "user", "content": user}]})
                r.raise_for_status()
                return r.json()["message"]["content"]
            r = self.session.post(f"{c.base_url.rstrip('/')}/v1/chat/completions", timeout=c.timeout_sec,
                                  json={"model": c.model, "temperature": c.temperature,
                                        "response_format": {"type": "json_object"},
                                        "messages": [{"role": "system", "content": system},
                                                     {"role": "user", "content": user}]})
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]
        except Exception as exc:  # network, timeout, bad payload
            log.warning("LLM unavailable: %s", exc)
            return None

    def healthy(self) -> bool:
        try:
            url = (f"{self.cfg.base_url.rstrip('/')}/api/tags" if self.cfg.provider == "ollama"
                   else f"{self.cfg.base_url.rstrip('/')}/v1/models")
            return self.session.get(url, timeout=5).ok
        except Exception:
            return False

    # ---- tasks -----------------------------------------------------------
    def analyze_entry(self, snapshot: dict, setup_summary: dict) -> EntryVerdict | None:
        user = ("Pre-screened setup:\n" + json.dumps(setup_summary) +
                "\n\nMarket data:\n" + json.dumps(snapshot))
        data = _extract_json(self.chat(ENTRY_SYSTEM, user) or "")
        if not data or str(data.get("decision", "")).upper() not in ("BUY", "SKIP"):
            return None
        return EntryVerdict(str(data["decision"]).upper() == "BUY", _conf(data.get("confidence")),
                            [str(x) for x in data.get("reasons", [])][:6],
                            [str(x) for x in data.get("risks", [])][:6])

    def review_position(self, snapshot: dict, position_summary: dict) -> ReviewVerdict | None:
        user = ("Open position:\n" + json.dumps(position_summary) +
                "\n\nMarket data:\n" + json.dumps(snapshot))
        data = _extract_json(self.chat(REVIEW_SYSTEM, user) or "")
        if not data:
            return None
        action = str(data.get("action", "")).upper()
        if action not in ("HOLD", "TIGHTEN", "CLOSE"):
            return None
        return ReviewVerdict(action, _conf(data.get("confidence")), str(data.get("reason", ""))[:300])
