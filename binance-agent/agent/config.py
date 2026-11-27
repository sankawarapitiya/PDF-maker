"""Typed configuration loaded from YAML (+ secrets from environment)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any, get_type_hints

import yaml


@dataclass
class ExchangeCfg:
    quote_asset: str = "USDT"
    symbols: list[str] = field(default_factory=lambda: ["BTC/USDT", "ETH/USDT"])
    entry_timeframe: str = "15m"
    trend_timeframe: str = "4h"
    candles: int = 300
    fee_rate: float = 0.001
    slippage: float = 0.0005


@dataclass
class LoopCfg:
    scan_interval_sec: int = 60
    monitor_interval_sec: int = 10
    llm_review_every_sec: int = 300


@dataclass
class RiskCfg:
    starting_equity: float = 1000.0
    risk_per_trade: float = 0.01
    max_position_pct: float = 0.25
    max_open_positions: int = 3
    max_daily_loss: float = 0.03
    max_drawdown: float = 0.15
    max_consecutive_losses: int = 4
    cooldown_after_loss_min: int = 60
    min_reward_risk: float = 2.0
    max_atr_pct: float = 0.06


@dataclass
class EntryCfg:
    min_tech_score: float = 65
    min_llm_confidence: float = 0.65
    require_llm: bool = True
    btc_filter: bool = True


@dataclass
class LockLevel:
    at: float
    lock: float


@dataclass
class PartialTPCfg:
    enabled: bool = True
    at_r: float = 2.0
    fraction: float = 0.33


@dataclass
class PyramidCfg:
    enabled: bool = False
    max_adds: int = 1
    add_at_r: float = 1.5
    add_fraction: float = 0.5


@dataclass
class ManagementCfg:
    atr_stop_mult: float = 1.8
    breakeven_at_r: float = 1.0
    lock_levels: list[LockLevel] = field(default_factory=lambda: [
        LockLevel(1.5, 0.5), LockLevel(2.0, 1.0), LockLevel(3.0, 1.8), LockLevel(4.0, 2.8)])
    trail_start_r: float = 2.0
    trail_atr_mult: float = 2.5
    trail_atr_mult_tight: float = 1.3
    tight_trail_after_r: float = 4.0
    partial_take_profit: PartialTPCfg = field(default_factory=PartialTPCfg)
    pyramiding: PyramidCfg = field(default_factory=PyramidCfg)
    risk_exit_score: float = 70
    risk_tighten_score: float = 45
    time_stop_bars: int = 48
    use_exchange_stop: bool = True


@dataclass
class LLMCfg:
    provider: str = "ollama"
    base_url: str = "http://localhost:11434"
    model: str = "qwen2.5:14b-instruct"
    temperature: float = 0.1
    timeout_sec: int = 90


@dataclass
class StorageCfg:
    db_path: str = "state/journal.db"
    log_dir: str = "logs"


@dataclass
class Config:
    mode: str = "paper"
    exchange: ExchangeCfg = field(default_factory=ExchangeCfg)
    loop: LoopCfg = field(default_factory=LoopCfg)
    risk: RiskCfg = field(default_factory=RiskCfg)
    entry: EntryCfg = field(default_factory=EntryCfg)
    management: ManagementCfg = field(default_factory=ManagementCfg)
    llm: LLMCfg = field(default_factory=LLMCfg)
    storage: StorageCfg = field(default_factory=StorageCfg)

    # secrets (never from YAML)
    api_key: str = ""
    api_secret: str = ""


def _build(cls: Any, data: Any) -> Any:
    """Recursively turn dicts into dataclasses, ignoring unknown keys loudly."""
    if not is_dataclass(cls) or not isinstance(data, dict):
        return data
    hints = get_type_hints(cls)
    kwargs = {}
    known = {f.name for f in fields(cls)}
    unknown = set(data) - known
    if unknown:
        raise ValueError(f"Unknown config keys for {cls.__name__}: {sorted(unknown)}")
    for name, value in data.items():
        t = hints[name]
        origin = getattr(t, "__origin__", None)
        if origin is list and t.__args__ and is_dataclass(t.__args__[0]):
            kwargs[name] = [_build(t.__args__[0], v) for v in value]
        elif is_dataclass(t):
            kwargs[name] = _build(t, value)
        else:
            kwargs[name] = value
    return cls(**kwargs)


def load_config(path: str | Path = "config.yaml") -> Config:
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

    p = Path(path)
    data = yaml.safe_load(p.read_text()) if p.exists() else {}
    cfg: Config = _build(Config, data or {})
    validate(cfg)

    if cfg.mode == "testnet":
        cfg.api_key = os.getenv("BINANCE_TESTNET_API_KEY", "")
        cfg.api_secret = os.getenv("BINANCE_TESTNET_API_SECRET", "")
    elif cfg.mode == "live":
        if os.getenv("CONFIRM_LIVE_TRADING", "NO") != "YES":
            raise SystemExit("Refusing live mode: set CONFIRM_LIVE_TRADING=YES in .env "
                             "after you have validated the strategy in paper/testnet.")
        cfg.api_key = os.getenv("BINANCE_API_KEY", "")
        cfg.api_secret = os.getenv("BINANCE_API_SECRET", "")
    if cfg.mode in ("testnet", "live") and not (cfg.api_key and cfg.api_secret):
        raise SystemExit(f"Mode '{cfg.mode}' needs API key/secret in .env")
    return cfg


def validate(cfg: Config) -> None:
    if cfg.mode not in ("paper", "testnet", "live"):
        raise ValueError("mode must be paper | testnet | live")
    r = cfg.risk
    if not 0 < r.risk_per_trade <= 0.03:
        raise ValueError("risk_per_trade must be in (0, 0.03] — >3% per trade is reckless")
    if not 0 < r.max_position_pct <= 1:
        raise ValueError("max_position_pct must be in (0, 1]")
    m = cfg.management
    for lv in m.lock_levels:
        if lv.lock >= lv.at:
            raise ValueError(f"lock level {lv}: lock must be below the trigger")
    if m.risk_tighten_score >= m.risk_exit_score:
        raise ValueError("risk_tighten_score must be < risk_exit_score")
