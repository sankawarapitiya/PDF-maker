"""Open-position state and the trade-management state machine.

Lifecycle of a long:
    ENTRY ──► at +1R: stop to break-even (+fees)       "can't lose anymore"
          ──► profit-lock ladder (+1.5R→lock 0.5R, +2R→1R, +3R→1.8R ...)
          ──► at +2R: bank a partial, ATR chandelier trail on the rest
          ──► optional pyramid add while stop is in profit (no extra risk)
          ──► momentum fades / LLM says TIGHTEN: switch to a tight trail
          ──► deterioration score high / LLM CLOSE w/ confirmation: exit now
          ──► stop hit / time stop: exit

Invariant: the stop only ever moves UP (ratchet). Nothing widens risk.
All logic here is pure (no I/O) so it is unit-tested and shared by the
live agent and the backtester.
"""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field

from .config import ManagementCfg


@dataclass
class Position:
    symbol: str
    entry_price: float          # average entry (changes on pyramid adds)
    initial_entry: float        # first fill — R is measured from here
    qty: float
    initial_qty: float
    initial_stop: float
    stop: float
    opened_at: float = field(default_factory=time.time)
    highest: float = 0.0
    bars_held: int = 0
    partial_taken: bool = False
    adds: int = 0
    realized_pnl: float = 0.0
    fees_paid: float = 0.0       # all fees (quote)
    entry_fees: float = 0.0      # buy-side fees, charged against the final PnL
    exchange_stop_price: float = 0.0
    stage: str = "initial"
    exchange_stop_id: str | None = None
    last_llm_review: float = 0.0
    last_bar_ts: float = 0.0
    entry_notes: str = ""
    history: list[str] = field(default_factory=list)

    def __post_init__(self):
        self.highest = self.highest or self.entry_price

    @property
    def risk_per_unit(self) -> float:
        return self.initial_entry - self.initial_stop

    @property
    def initial_risk_amount(self) -> float:
        return self.risk_per_unit * self.initial_qty

    def r_multiple(self, price: float) -> float:
        return (price - self.initial_entry) / self.risk_per_unit if self.risk_per_unit > 0 else 0.0

    @property
    def max_r(self) -> float:
        return self.r_multiple(self.highest)

    def unrealized(self, price: float) -> float:
        return (price - self.entry_price) * self.qty

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Position":
        return cls(**d)


@dataclass
class Decision:
    new_stop: float | None = None
    close: bool = False
    close_reason: str = ""
    partial_qty: float = 0.0
    add_qty: float = 0.0
    stage: str | None = None
    notes: list[str] = field(default_factory=list)


class TradeManager:
    def __init__(self, cfg: ManagementCfg, fee_rate: float = 0.001):
        self.cfg = cfg
        self.fee = fee_rate

    def initial_stop_ok(self, entry: float, stop: float) -> bool:
        return 0 < stop < entry

    def evaluate(self, p: Position, price: float, high: float, atr: float,
                 risk_score: float = 0.0, llm_action: str | None = None,
                 llm_conf: float = 0.0, new_bar: bool = False) -> Decision:
        c = self.cfg
        d = Decision()
        if new_bar:
            p.bars_held += 1
        p.highest = max(p.highest, high, price)
        r_now, r_max = p.r_multiple(price), p.max_r

        # 1) hard stop
        if price <= p.stop:
            return Decision(close=True, close_reason=f"stop hit @ {p.stop:.6g} ({p.stage})")

        # 2) risk-driven exits (before the stop is reached)
        if risk_score >= c.risk_exit_score:
            return Decision(close=True, close_reason=f"risk exit: deterioration {risk_score:.0f}")
        if llm_action == "CLOSE" and (llm_conf >= 0.9 or
                                      (llm_conf >= 0.7 and risk_score >= c.risk_tighten_score)):
            return Decision(close=True, close_reason=f"LLM risk exit (conf {llm_conf:.2f}, tech {risk_score:.0f})")
        if p.bars_held >= c.time_stop_bars and r_max < 0.5:
            return Decision(close=True, close_reason=f"time stop: {p.bars_held} bars without progress")

        # 3) stop ratchet — collect candidates, take the highest
        cands: list[tuple[float, str]] = []
        if r_max >= c.breakeven_at_r:
            cands.append((p.initial_entry * (1 + 2.5 * self.fee), "breakeven"))
        for lv in sorted(c.lock_levels, key=lambda x: x.at):
            if r_max >= lv.at:
                cands.append((p.initial_entry + lv.lock * p.risk_per_unit, f"lock {lv.lock}R"))
        weakening = risk_score >= c.risk_tighten_score or (llm_action == "TIGHTEN" and llm_conf >= 0.6)
        if r_max >= c.trail_start_r:
            tight = weakening or r_max >= c.tight_trail_after_r
            mult = c.trail_atr_mult_tight if tight else c.trail_atr_mult
            cands.append((p.highest - mult * atr, f"trail {mult}xATR"))
        if weakening:
            # protect: in profit -> trail tightly under price; in loss -> cut risk under price
            cands.append((price - 1.0 * atr, "tighten (weakening)"))

        best_stop, best_tag = p.stop, None
        for s, tag in cands:
            if s > best_stop:
                best_stop, best_tag = s, tag
        if best_tag:
            if best_stop >= price:  # tightened above market -> just exit
                return Decision(close=True, close_reason=f"{best_tag} level above price")
            d.new_stop, d.stage = best_stop, best_tag
            d.notes.append(f"stop {p.stop:.6g} → {best_stop:.6g} [{best_tag}] at {r_now:+.2f}R")

        # 4) partial take-profit: bank some, let the rest run free
        pt = c.partial_take_profit
        if pt.enabled and not p.partial_taken and r_now >= pt.at_r:
            d.partial_qty = p.qty * pt.fraction
            d.notes.append(f"partial TP {pt.fraction:.0%} at {r_now:+.2f}R")

        # 5) pyramiding ("uplift"): add to a winner only if total risk stays <= initial risk
        py = c.pyramiding
        effective_stop = d.new_stop or p.stop
        if (py.enabled and p.adds < py.max_adds and r_now >= py.add_at_r * (p.adds + 1)
                and effective_stop >= p.initial_entry and not weakening and d.partial_qty == 0):
            add = p.initial_qty * py.add_fraction
            while add > p.initial_qty * 0.05:
                new_qty = p.qty + add
                new_avg = (p.entry_price * p.qty + price * add) / new_qty
                if (new_avg - effective_stop) * new_qty <= p.initial_risk_amount:
                    d.add_qty = add
                    d.notes.append(f"pyramid add {add:.6g} @ {price:.6g}")
                    break
                add *= 0.5
        return d

    @staticmethod
    def apply_add(p: Position, add_qty: float, price: float, fee: float) -> None:
        new_qty = p.qty + add_qty
        p.entry_price = (p.entry_price * p.qty + price * add_qty) / new_qty
        p.qty = new_qty
        p.adds += 1
        p.fees_paid += fee
        p.entry_fees += fee

    @staticmethod
    def apply_partial(p: Position, qty: float, price: float, fee: float) -> float:
        pnl = (price - p.entry_price) * qty - fee
        p.qty -= qty
        p.realized_pnl += pnl
        p.fees_paid += fee
        p.partial_taken = True
        return pnl
