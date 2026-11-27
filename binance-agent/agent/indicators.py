"""Dependency-free technical indicators on pandas OHLCV frames.

Frames are expected to have columns: open, high, low, close, volume
indexed by timestamp (ascending).
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(100.0)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    pc = df["close"].shift()
    tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()],
                   axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def macd(close: pd.Series, fast=12, slow=26, signal=9):
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line, signal)
    return line, sig, line - sig


def adx(df: pd.DataFrame, n: int = 14) -> pd.Series:
    up = df["high"].diff()
    dn = -df["low"].diff()
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    a = atr(df, n).replace(0, np.nan)
    plus_di = 100 * pd.Series(plus_dm, index=df.index).ewm(alpha=1 / n, adjust=False).mean() / a
    minus_di = 100 * pd.Series(minus_dm, index=df.index).ewm(alpha=1 / n, adjust=False).mean() / a
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False).mean().fillna(0)


def bollinger(close: pd.Series, n=20, k=2.0):
    mid = close.rolling(n).mean()
    sd = close.rolling(n).std()
    return mid - k * sd, mid, mid + k * sd


def enrich(df: pd.DataFrame) -> pd.DataFrame:
    """Return a copy with all indicators the agent uses."""
    out = df.copy()
    c = out["close"]
    out["ema9"] = ema(c, 9)
    out["ema21"] = ema(c, 21)
    out["ema50"] = ema(c, 50)
    out["ema200"] = ema(c, 200)
    out["rsi"] = rsi(c)
    out["atr"] = atr(out)
    out["atr_pct"] = out["atr"] / c
    out["macd"], out["macd_sig"], out["macd_hist"] = macd(c)
    out["adx"] = adx(out)
    out["bb_lo"], out["bb_mid"], out["bb_hi"] = bollinger(c)
    out["vol_ma"] = out["volume"].rolling(20).mean()
    out["vol_ratio"] = out["volume"] / out["vol_ma"]
    return out


def swing_low(df: pd.DataFrame, lookback: int = 10) -> float:
    return float(df["low"].iloc[-lookback:].min())


def swing_high(df: pd.DataFrame, lookback: int = 50, exclude_last: int = 1) -> float:
    seg = df["high"].iloc[-lookback - exclude_last:-exclude_last or None]
    return float(seg.max())


def bearish_divergence(df: pd.DataFrame, lookback: int = 20) -> bool:
    """Price made a higher high while RSI made a lower high."""
    seg = df.iloc[-lookback:]
    if len(seg) < lookback:
        return False
    half = lookback // 2
    a, b = seg.iloc[:half], seg.iloc[half:]
    return bool(b["high"].max() > a["high"].max() and b["rsi"].max() < a["rsi"].max() - 3)


def resample(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    agg = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    return df.resample(rule).agg(agg).dropna()
