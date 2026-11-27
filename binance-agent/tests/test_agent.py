"""Integration: drive the real TradingAgent with a fake exchange replaying
synthetic candles and a fake LLM."""
from agent.agent import TradingAgent
from agent.backtest import synthetic_ohlcv
from agent.broker import Fill, PaperBroker
from agent.config import Config
from agent.indicators import resample
from agent.journal import Journal
from agent.llm import EntryVerdict, ReviewVerdict


class FakeBroker(PaperBroker):
    def __init__(self, df):
        self.df, self.i = df, 300
        self.cash, self.fee_rate, self.slip, self.quote = 1000.0, 0.001, 0.0, "USDT"
        self.holdings = {}

    def amount(self, s, q): return round(q, 6)
    def last_price(self, s): return float(self.df.close.iloc[self.i])

    def fetch_ohlcv(self, symbol, tf, limit=300, closed_only=True):
        upto = self.df.iloc[: self.i + 1]
        out = upto if tf == "15m" else resample(upto, "4h")
        out = out.iloc[-limit - 1:]
        return out.iloc[:-1] if closed_only else out


class FakeLLM:
    def healthy(self): return True
    def analyze_entry(self, snap, setup): return EntryVerdict(True, 0.9, ["ok"], [])
    def review_position(self, snap, pos): return ReviewVerdict("HOLD", 0.5, "fine")


def test_agent_full_cycle(tmp_path):
    cfg = Config()
    cfg.exchange.symbols = ["BTC/USDT"]
    cfg.loop.llm_review_every_sec = 0
    cfg.entry.min_tech_score = 50
    broker = FakeBroker(synthetic_ohlcv(n=3000, seed=3))
    agent = TradingAgent(cfg, broker, FakeLLM(), Journal(str(tmp_path / "j.db")))
    entries, last_stop = 0, {}
    while broker.i < len(broker.df) - 1:
        broker.i += 1
        if "BTC/USDT" in agent.positions:
            p = agent.positions["BTC/USDT"]
            agent.manage_all()
            if "BTC/USDT" in agent.positions:
                assert p.stop >= last_stop.get(id(p), 0)  # ratchet invariant
                last_stop[id(p)] = p.stop
        else:
            agent.scan()
            entries += "BTC/USDT" in agent.positions
    stats = agent.j.stats()
    assert entries > 0 and stats["trades"] >= entries - 1
    # restart restores state
    again = TradingAgent(cfg, broker, FakeLLM(), Journal(str(tmp_path / "j.db")))
    assert set(again.positions) == set(agent.positions)
    assert abs(again.broker.cash - agent.broker.cash) < 1e-9
