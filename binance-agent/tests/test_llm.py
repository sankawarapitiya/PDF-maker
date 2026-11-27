from agent.config import LLMCfg
from agent.llm import LocalLLM, _extract_json


def test_extract_json_variants():
    assert _extract_json('{"a":1}') == {"a": 1}
    assert _extract_json('```json\n{"a":1}\n```') == {"a": 1}
    assert _extract_json('Sure! {"a": 1} hope it helps') == {"a": 1}
    assert _extract_json("no json") is None


def test_garbage_output_means_no_opinion(monkeypatch):
    llm = LocalLLM(LLMCfg())
    monkeypatch.setattr(llm, "chat", lambda s, u: '{"decision": "MAYBE"}')
    assert llm.analyze_entry({}, {}) is None
    monkeypatch.setattr(llm, "chat", lambda s, u: None)
    assert llm.review_position({}, {}) is None


def test_confidence_clamped(monkeypatch):
    llm = LocalLLM(LLMCfg())
    monkeypatch.setattr(llm, "chat", lambda s, u: '{"decision":"BUY","confidence":7}')
    assert llm.analyze_entry({}, {}).confidence == 1.0
