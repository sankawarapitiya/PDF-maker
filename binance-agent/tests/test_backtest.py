from agent.backtest import backtest, synthetic_ohlcv
from agent.config import Config


def test_backtest_runs_and_accounts():
    cfg = Config()
    df = synthetic_ohlcv(n=2500, seed=11)
    res = backtest(df, cfg)
    s = res.summary(cfg.risk.starting_equity)
    assert len(res.equity_curve) == len(df) - 250
    if s["trades"]:
        assert abs(res.equity_curve[-1] - (1000 + s["net_pnl"])) < 0.05
        assert s["worst_r"] > -2.5  # stops respected (gap tolerance)


def test_no_lookahead_future_does_not_change_past_decisions():
    cfg = Config()
    df = synthetic_ohlcv(n=3000, seed=5)
    a = backtest(df.iloc[:2000], cfg).trades
    b = backtest(df, cfg).trades
    closed_a = [t for t in a if t["reason"] != "end of data"]
    assert [t["opened"] for t in closed_a] == [t["opened"] for t in b[: len(closed_a)]]
