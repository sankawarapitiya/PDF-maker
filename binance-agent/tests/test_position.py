from agent.config import ManagementCfg, PyramidCfg, PartialTPCfg
from agent.position import Position, TradeManager


def mk(entry=100.0, stop=90.0, qty=1.0):
    return Position("BTC/USDT", entry, entry, qty, qty, stop, stop)


def tm(**kw):
    return TradeManager(ManagementCfg(**kw), fee_rate=0.001)


def test_stop_hit_closes():
    d = tm().evaluate(mk(), price=89.9, high=100, atr=2)
    assert d.close and "stop hit" in d.close_reason


def test_breakeven_at_1r():
    p = mk()
    d = tm().evaluate(p, price=110, high=110, atr=2)
    assert d.new_stop is not None and d.new_stop >= 100  # >= entry incl. fees
    assert d.new_stop < 110


def test_lock_ladder_locks_profit():
    p = mk()
    d = tm(trail_start_r=99).evaluate(p, price=130, high=130, atr=2)  # +3R
    assert abs(d.new_stop - (100 + 1.8 * 10)) < 1e-9   # lock 1.8R


def test_trailing_ratchets_up_never_down():
    m, p = tm(), mk()
    stops, stopped_at = [], None
    for px in [105, 112, 121, 125, 119, 126, 131, 127]:
        if px <= p.stop:
            stopped_at = px
            break
        d = m.evaluate(p, price=px, high=px, atr=2)
        if d.new_stop:
            assert d.new_stop > p.stop
            p.stop = d.new_stop
        stops.append(p.stop)
    assert stops == sorted(stops)
    # trail from the 125 high (125 - 2.5*ATR = 120) catches the pullback to 119:
    # exits with +2R locked instead of giving the move back
    assert stopped_at == 119 and p.stop == 120


def test_high_risk_score_exits_before_stop():
    d = tm().evaluate(mk(), price=97, high=101, atr=2, risk_score=80)
    assert d.close and "risk exit" in d.close_reason


def test_moderate_risk_tightens_instead():
    p = mk()
    d = tm().evaluate(p, price=97, high=101, atr=2, risk_score=50)
    assert not d.close and d.new_stop == 95  # price - 1 ATR, above initial 90


def test_llm_close_needs_confirmation_unless_very_confident():
    m = tm()
    assert not m.evaluate(mk(), 101, 101, 2, risk_score=10, llm_action="CLOSE", llm_conf=0.75).close
    assert m.evaluate(mk(), 101, 101, 2, risk_score=50, llm_action="CLOSE", llm_conf=0.75).close
    assert m.evaluate(mk(), 101, 101, 2, risk_score=0, llm_action="CLOSE", llm_conf=0.95).close


def test_llm_cannot_widen_stop():
    p = mk(); p.stop = 95
    d = tm().evaluate(p, 101, 101, 2, llm_action="HOLD", llm_conf=1.0)
    assert d.new_stop is None or d.new_stop >= 95


def test_partial_take_profit_once():
    p = mk()
    m = tm(partial_take_profit=PartialTPCfg(True, 2.0, 0.5))
    d = m.evaluate(p, 121, 121, 2)
    assert d.partial_qty == 0.5
    TradeManager.apply_partial(p, d.partial_qty, 121, 0.0)
    assert p.realized_pnl == 10.5 and p.qty == 0.5
    assert m.evaluate(p, 122, 122, 2).partial_qty == 0


def test_pyramid_never_increases_risk():
    p = mk()
    m = tm(pyramiding=PyramidCfg(True, 1, 1.5, 0.5),
           partial_take_profit=PartialTPCfg(enabled=False))
    d = m.evaluate(p, 116, 116, 2)
    assert d.add_qty > 0
    p.stop = d.new_stop
    TradeManager.apply_add(p, d.add_qty, 116, 0.0)
    assert (p.entry_price - p.stop) * p.qty <= p.initial_risk_amount + 1e-9


def test_time_stop():
    p = mk()
    m = tm(time_stop_bars=3)
    for _ in range(2):
        assert not m.evaluate(p, 101, 101, 2, new_bar=True).close
    assert m.evaluate(p, 101, 101, 2, new_bar=True).close
