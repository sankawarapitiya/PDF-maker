"""Technical analyst: multi-timeframe confluence scoring for entries and
deterioration scoring for open positions.

This layer is deterministic and fast. The LLM is only consulted once this
layer has found a statistically sensible setup — the LLM is a *filter*, not
the signal generator. That keeps the bot robust if the LLM hallucinates.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from .config import Config
from .indicators import bearish_divergence, swing_high, swing_low


@dataclass
class Setup:
    symbol: str
    score: float
    price: float
    stop: float
    target: float
    atr: float
    reasons: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)

    @property
    def risk_per_unit(self) -> float:
        return self.price - self.stop

    @property
    def reward_risk(self) -> float:
        return (self.target - self.price) / self.risk_per_unit if self.risk_per_unit > 0 else 0.0


def trend_state(tdf: pd.DataFrame) -> str:
    """bull / bear / neutral regime from the higher timeframe."""
    t = tdf.iloc[-1]
    slope = tdf["ema50"].iloc[-1] - tdf["ema50"].iloc[-6]
    if t.close > t.ema50 > t.ema200 and slope > 0:
        return "bull"
    if t.close < t.ema50 < t.ema200 and slope < 0:
        return "bear"
    return "neutral"


def evaluate_entry(symbol: str, edf: pd.DataFrame, tdf: pd.DataFrame, cfg: Config,
                   btc_tdf: pd.DataFrame | None = None) -> Setup:
    """Score a long entry on the latest *closed* candle of edf (enriched)."""
    e, prev = edf.iloc[-1], edf.iloc[-2]
    score = 0.0
    why, block = [], []

    # ---------- hard gates ----------
    regime = trend_state(tdf)
    if regime == "bear":
        block.append("higher-timeframe downtrend")
    if e.atr_pct > cfg.risk.max_atr_pct:
        block.append(f"volatility too high (ATR {e.atr_pct:.1%})")
    if cfg.entry.btc_filter and btc_tdf is not None and not symbol.startswith("BTC/"):
        if trend_state(btc_tdf) == "bear":
            block.append("BTC regime bearish")
    if e.rsi > 78:
        block.append("RSI overbought — would be chasing")

    # ---------- confluence points ----------
    t = tdf.iloc[-1]
    if regime == "bull":
        score += 20; why.append("HTF uptrend (close>EMA50>EMA200, rising)")
    elif t.close > t.ema50:
        score += 8; why.append("HTF above EMA50")
    if t.adx > 20:
        score += 5; why.append(f"HTF trend strength ADX {t.adx:.0f}")

    if e.ema21 > e.ema50:
        score += 10; why.append("entry TF EMA21>EMA50")
    if e.close > e.ema50:
        score += 5

    recent = edf.iloc[-6:-1]
    touched = (recent["low"] <= recent["ema21"] * 1.003).any()
    if touched and e.close > e.ema21 and e.close > prev.close:
        score += 15; why.append("pullback to EMA21 bounced")
    elif e.close > swing_high(edf, 20) and e.vol_ratio > 1.5:
        score += 12; why.append("breakout of 20-bar high on volume")

    if 45 <= e.rsi <= 68 and e.rsi > prev.rsi:
        score += 10; why.append(f"RSI {e.rsi:.0f} rising in sweet spot")
    elif e.rsi > 72:
        score -= 10

    if e.macd_hist > prev.macd_hist:
        score += 7; why.append("MACD momentum improving")
        if prev.macd_hist <= 0 < e.macd_hist:
            score += 5; why.append("MACD histogram crossed up")

    if e.close > e.open and e.vol_ratio > 1.2:
        score += 10; why.append(f"bullish candle on {e.vol_ratio:.1f}x volume")
    rng = e.high - e.low
    if rng > 0 and (e.close - e.low) / rng > 0.6:
        score += 5; why.append("strong close in upper range")
    if e.adx > 20:
        score += 5

    if bearish_divergence(edf):
        score -= 15; block.append("bearish RSI divergence")

    # ---------- stop & target ----------
    price = float(e.close)
    a = float(e.atr)
    atr_stop = price - cfg.management.atr_stop_mult * a
    struct_stop = swing_low(edf, 10) - 0.25 * a
    stop = min(atr_stop, struct_stop)          # below structure AND outside noise
    stop = max(stop, price - 3.5 * a)          # but never absurdly wide
    resistance = swing_high(edf, 100)
    target = resistance if resistance > price + a else price + 3.0 * (price - stop)  # blue sky

    s = Setup(symbol, max(0.0, min(100.0, score)), price, stop, target, a, why, block)
    if s.reward_risk < cfg.risk.min_reward_risk:
        block.append(f"R:R {s.reward_risk:.2f} below {cfg.risk.min_reward_risk}")
    return s


def deterioration_score(edf: pd.DataFrame, tdf: pd.DataFrame | None = None,
                        btc_edf: pd.DataFrame | None = None) -> tuple[float, list[str]]:
    """0-100: how strongly the market is turning against an open long."""
    e, prev = edf.iloc[-1], edf.iloc[-2]
    s, why = 0.0, []
    if e.close < e.ema21:
        s += 20; why.append("closed below EMA21")
    if e.close < e.ema50:
        s += 20; why.append("closed below EMA50")
    if e.macd_hist < 0 and e.macd_hist < prev.macd_hist:
        s += 15; why.append("MACD momentum negative & falling")
    if e.rsi < 45:
        s += 10; why.append(f"RSI weak {e.rsi:.0f}")
    if edf["rsi"].iloc[-6:-1].max() > 70 and e.rsi < 55:
        s += 10; why.append("RSI collapsed from overbought")
    if bearish_divergence(edf):
        s += 15; why.append("bearish divergence")
    body = e.open - e.close
    if body > 1.5 * e.atr:
        s += 15; why.append("large bearish candle")
    if e.close < e.open and e.vol_ratio > 2:
        s += 10; why.append("selling volume spike")
    if tdf is not None and tdf.iloc[-1].close < tdf.iloc[-1].ema50:
        s += 15; why.append("HTF lost EMA50")
    if btc_edf is not None:
        b = btc_edf.iloc[-1]
        if (b.close - b.open) / b.open < -2 * b.atr_pct:
            s += 15; why.append("BTC dumping")
    return min(100.0, s), why


def market_snapshot(symbol: str, edf: pd.DataFrame, tdf: pd.DataFrame, efm: str, tfm: str) -> dict:
    """Compact numeric summary for the LLM (small models do better with less noise)."""
    def frame(df: pd.DataFrame) -> dict:
        r = df.iloc[-1]
        return {
            "close": round(float(r.close), 8),
            "ema21": round(float(r.ema21), 8), "ema50": round(float(r.ema50), 8),
            "ema200": round(float(r.ema200), 8),
            "rsi": round(float(r.rsi), 1), "adx": round(float(r.adx), 1),
            "macd_hist": round(float(r.macd_hist), 8),
            "macd_hist_prev": round(float(df.macd_hist.iloc[-2]), 8),
            "atr_pct": round(float(r.atr_pct) * 100, 2),
            "volume_vs_avg": round(float(r.vol_ratio), 2),
            "bb_position": round(float((r.close - r.bb_lo) / max(r.bb_hi - r.bb_lo, 1e-12)), 2),
            "change_10_bars_pct": round(float(df.close.iloc[-1] / df.close.iloc[-11] - 1) * 100, 2),
            "trend": trend_state(df),
        }
    last = edf.iloc[-12:]
    candles = [[round((c.close / c.open - 1) * 100, 2), round((c.high - c.low) / c.open * 100, 2),
                round(float(c.vol_ratio), 1)] for c in last.itertuples()]
    return {"symbol": symbol, f"entry_tf_{efm}": frame(edf), f"trend_tf_{tfm}": frame(tdf),
            "last_12_candles[body%,range%,vol_x]": candles}
