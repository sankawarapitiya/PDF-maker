from agent.config import RiskCfg
from agent.risk import RiskManager


def test_fixed_fractional_size():
    r = RiskManager(RiskCfg(risk_per_trade=0.01, max_position_pct=1.0))
    qty = r.position_size(100, 95, equity=1000, free_quote=1000)
    assert abs(qty * 5 - 10) < 1e-9  # lose exactly 1% at stop


def test_size_capped_by_max_position():
    r = RiskManager(RiskCfg(risk_per_trade=0.01, max_position_pct=0.25))
    qty = r.position_size(100, 99.9, equity=1000, free_quote=1000)
    assert qty * 100 <= 250 + 1e-9


def test_kill_switch_on_drawdown():
    r = RiskManager(RiskCfg(max_drawdown=0.1))
    r.on_equity(1000); r.on_equity(890)
    ok, why = r.can_open("BTC/USDT", 0, 890)
    assert not ok and "KILL" in why


def test_daily_loss_and_cooldown():
    r = RiskManager(RiskCfg(max_daily_loss=0.03, cooldown_after_loss_min=60))
    r.on_equity(1000, now=1_700_000_000)
    assert not r.can_open("X", 0, 960, now=1_700_000_100)[0]
    r2 = RiskManager(RiskCfg())
    r2.on_trade_closed("ETH/USDT", -5, now=1000)
    assert not r2.can_open("ETH/USDT", 0, 1000, now=1100)[0]
    assert r2.can_open("SOL/USDT", 0, 1000, now=1100)[0]
