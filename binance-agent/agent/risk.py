"""Portfolio-level risk: sizing, daily loss limit, drawdown kill switch,
losing-streak pause and per-symbol cooldown."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .config import RiskCfg


@dataclass
class RiskState:
    peak_equity: float = 0.0
    day: str = ""
    day_start_equity: float = 0.0
    consecutive_losses: int = 0
    halted: bool = False
    halt_reason: str = ""
    pause_until: float = 0.0
    cooldowns: dict[str, float] = field(default_factory=dict)


class RiskManager:
    MIN_NOTIONAL = 6.0  # Binance spot min is ~5 USDT; keep a buffer

    def __init__(self, cfg: RiskCfg, state: RiskState | None = None):
        self.cfg = cfg
        self.s = state or RiskState()

    def on_equity(self, equity: float, now: float | None = None) -> None:
        now = now or time.time()
        day = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")
        if day != self.s.day:
            self.s.day, self.s.day_start_equity = day, equity
        self.s.peak_equity = max(self.s.peak_equity, equity)
        if self.s.peak_equity and equity <= self.s.peak_equity * (1 - self.cfg.max_drawdown):
            self.s.halted = True
            self.s.halt_reason = (f"KILL SWITCH: drawdown {1 - equity / self.s.peak_equity:.1%} "
                                  f">= {self.cfg.max_drawdown:.0%}")

    def daily_loss_hit(self, equity: float) -> bool:
        return bool(self.s.day_start_equity) and \
            equity <= self.s.day_start_equity * (1 - self.cfg.max_daily_loss)

    def can_open(self, symbol: str, open_positions: int, equity: float,
                 now: float | None = None) -> tuple[bool, str]:
        now = now or time.time()
        if self.s.halted:
            return False, self.s.halt_reason
        if self.daily_loss_hit(equity):
            return False, "daily loss limit reached"
        if now < self.s.pause_until:
            return False, "paused after losing streak"
        if open_positions >= self.cfg.max_open_positions:
            return False, "max open positions"
        if now < self.s.cooldowns.get(symbol, 0):
            return False, "symbol cooldown after loss"
        return True, ""

    def position_size(self, entry: float, stop: float, equity: float, free_quote: float) -> float:
        """Fixed-fractional sizing: lose `risk_per_trade` of equity if stop hits."""
        rpu = entry - stop
        if rpu <= 0 or entry <= 0:
            return 0.0
        qty = equity * self.cfg.risk_per_trade / rpu
        qty = min(qty, equity * self.cfg.max_position_pct / entry, free_quote * 0.98 / entry)
        return qty if qty * entry >= self.MIN_NOTIONAL else 0.0

    def on_trade_closed(self, symbol: str, pnl: float, now: float | None = None) -> None:
        now = now or time.time()
        if pnl < 0:
            self.s.consecutive_losses += 1
            self.s.cooldowns[symbol] = now + self.cfg.cooldown_after_loss_min * 60
            if self.s.consecutive_losses >= self.cfg.max_consecutive_losses:
                self.s.pause_until = now + 6 * 3600
                self.s.consecutive_losses = 0
        else:
            self.s.consecutive_losses = 0
