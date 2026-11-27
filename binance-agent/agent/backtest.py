"""Event-driven backtester that reuses the *same* entry analyst and
TradeManager as the live agent (no separate "backtest logic" to drift).

No look-ahead:
  * signals use closed bars only; fills happen at the NEXT bar's open
  * higher-timeframe candles are only visible after they have closed
  * stops are checked against the bar low before any management update;
    a gap below the stop fills at the open (worse), never at the stop
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .analyst import deterioration_score, evaluate_entry, market_snapshot
from .config import Config
from .indicators import enrich, resample
from .position import Position, TradeManager
from .risk import RiskManager

PANDAS_RULE = {"15m": "15min", "30m": "30min", "1h": "1h", "2h": "2h", "4h": "4h", "1d": "1D"}


@dataclass
class BTResult:
    trades: list[dict] = field(default_factory=list)
    equity_curve: list[float] = field(default_factory=list)

    def summary(self, start: float) -> dict:
        if not self.trades:
            return {"trades": 0}
        pnl = np.array([t["pnl"] for t in self.trades])
        rs = np.array([t["r"] for t in self.trades])
        eq = np.array(self.equity_curve)
        dd = (1 - eq / np.maximum.accumulate(eq)).max()
        losses = -pnl[pnl <= 0].sum()
        reasons: dict[str, int] = {}
        for t in self.trades:
            k = t["reason"].split(":")[0].split(" @")[0].split(" (")[0]
            reasons[k] = reasons.get(k, 0) + 1
        return {"trades": len(pnl), "win_rate": round(float((pnl > 0).mean()), 3),
                "net_pnl": round(float(pnl.sum()), 2),
                "return_pct": round(float(pnl.sum() / start * 100), 2),
                "profit_factor": round(float(pnl[pnl > 0].sum() / losses), 2) if losses else float("inf"),
                "avg_r": round(float(rs.mean()), 2), "best_r": round(float(rs.max()), 2),
                "worst_r": round(float(rs.min()), 2), "max_drawdown_pct": round(float(dd * 100), 2),
                "exit_reasons": reasons}


def backtest(df: pd.DataFrame, cfg: Config, symbol: str = "BTC/USDT", llm=None,
             warmup: int = 250) -> BTResult:
    x = cfg.exchange
    edf = enrich(df)
    trend_raw = resample(df, PANDAS_RULE[x.trend_timeframe])
    tdf_all = enrich(trend_raw)
    t_delta = pd.Timedelta(PANDAS_RULE[x.trend_timeframe])
    e_delta = pd.Timedelta(PANDAS_RULE[x.entry_timeframe])
    tdf_close_time = tdf_all.index + t_delta

    tm = TradeManager(cfg.management, x.fee_rate)
    risk = RiskManager(cfg.risk)
    cash = cfg.risk.starting_equity
    pos: Position | None = None
    pending = None
    res = BTResult()
    fee, slip = x.fee_rate, x.slippage

    def close_pos(px: float, reason: str, ts):
        nonlocal cash, pos
        px *= (1 - slip)
        f = px * pos.qty * fee
        cash += px * pos.qty - f
        pnl = pos.realized_pnl + (px - pos.entry_price) * pos.qty - f - pos.entry_fees
        r = pnl / pos.initial_risk_amount
        res.trades.append({"opened": pos.opened_at, "closed": ts, "entry": pos.initial_entry, "exit": px,
                           "pnl": pnl, "r": r, "reason": reason, "max_r": pos.max_r})
        risk.on_trade_closed(symbol, pnl, ts.timestamp())
        pos = None

    for i in range(warmup, len(edf)):
        bar = edf.iloc[i]
        ts = edf.index[i]

        # --- fill pending entry at this bar's open
        if pending is not None and pos is None:
            stop_dist = pending.price - pending.stop
            px = bar.open * (1 + slip)
            qty = risk.position_size(px, px - stop_dist, cash, cash)
            if qty > 0:
                f = px * qty * fee
                cash -= px * qty + f
                pos = Position(symbol, px, px, qty, qty, px - stop_dist, px - stop_dist,
                               opened_at=ts.timestamp(), fees_paid=f, entry_fees=f)
        pending = None

        # --- manage open position on this bar
        if pos is not None:
            if bar.low <= pos.stop:
                close_pos(min(bar.open, pos.stop), f"stop hit ({pos.stage})", ts)
            else:
                window = edf.iloc[: i + 1]
                tdf = tdf_all[tdf_close_time <= ts + e_delta]
                rscore, _ = deterioration_score(window, tdf)
                d = tm.evaluate(pos, float(bar.close), float(bar.high), float(bar.atr),
                                rscore, None, 0.0, new_bar=True)
                if d.close:
                    close_pos(float(bar.close), d.close_reason, ts)
                else:
                    if d.partial_qty:
                        px = bar.close * (1 - slip)
                        f = px * d.partial_qty * fee
                        cash += px * d.partial_qty - f
                        TradeManager.apply_partial(pos, d.partial_qty, px, f)
                    if d.add_qty:
                        px = bar.close * (1 + slip)
                        f = px * d.add_qty * fee
                        if cash > px * d.add_qty + f:
                            cash -= px * d.add_qty + f
                            TradeManager.apply_add(pos, d.add_qty, px, f)
                    if d.new_stop:
                        pos.stop, pos.stage = d.new_stop, d.stage

        mark = cash + (pos.qty * bar.close if pos else 0)
        res.equity_curve.append(mark)
        risk.on_equity(mark, ts.timestamp())

        # --- look for a new entry on this closed bar
        if pos is None and i < len(edf) - 1:
            ok, _ = risk.can_open(symbol, 0, mark, ts.timestamp())
            if not ok:
                continue
            tdf = tdf_all[tdf_close_time <= ts + e_delta]
            if len(tdf) < 60:
                continue
            window = edf.iloc[: i + 1]
            s = evaluate_entry(symbol, window, tdf, cfg)
            if s.blockers or s.score < cfg.entry.min_tech_score:
                continue
            if llm is not None:
                v = llm.analyze_entry(market_snapshot(symbol, window, tdf, x.entry_timeframe,
                                                      x.trend_timeframe),
                                      {"tech_score": s.score, "reward_risk": round(s.reward_risk, 2),
                                       "tech_reasons": s.reasons})
                if v is None or not v.buy or v.confidence < cfg.entry.min_llm_confidence:
                    continue
            pending = s

    if pos is not None:
        close_pos(float(edf.iloc[-1].close), "end of data", edf.index[-1])
    return res


def synthetic_ohlcv(n: int = 6000, seed: int = 7, start="2025-01-01", freq="15min") -> pd.DataFrame:
    """Regime-switching random walk (trends + chop) for offline testing/demo."""
    rng = np.random.default_rng(seed)
    drift = np.zeros(n)
    i = 0
    while i < n:
        L = rng.integers(150, 600)
        drift[i:i + L] = rng.choice([0.0009, -0.0007, 0.0, 0.0])
        i += L
    vol = 0.004 * (1 + 0.5 * np.sin(np.arange(n) / 300) ** 2)
    rets = drift + vol * rng.standard_t(4, n) / np.sqrt(2)
    close = 30000 * np.exp(np.cumsum(rets))
    open_ = np.concatenate([[close[0]], close[:-1]])
    spread = np.abs(rng.normal(0, vol, n)) * close
    high = np.maximum(open_, close) + spread
    low = np.minimum(open_, close) - spread
    volume = rng.lognormal(3, 0.4, n) * (1 + 8 * np.abs(rets) / vol.mean())
    idx = pd.date_range(start, periods=n, freq=freq, tz="UTC")
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": volume},
                        index=idx)
