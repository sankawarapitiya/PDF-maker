"""The agent loop: SCAN → (tech filter) → LLM confirm → ENTER → MONITOR/MANAGE → EXIT."""
from __future__ import annotations

import logging
import signal
import time
from dataclasses import asdict

from .analyst import deterioration_score, evaluate_entry, market_snapshot
from .broker import Fill, PaperBroker
from .config import Config
from .indicators import enrich
from .journal import Journal
from .llm import LocalLLM
from .position import Position, TradeManager
from .risk import RiskManager, RiskState

log = logging.getLogger("agent")
TF_SECONDS = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600,
              "2h": 7200, "4h": 14400, "6h": 21600, "12h": 43200, "1d": 86400}


class TradingAgent:
    def __init__(self, cfg: Config, broker, llm: LocalLLM, journal: Journal):
        self.cfg, self.broker, self.llm, self.j = cfg, broker, llm, journal
        self.manager = TradeManager(cfg.management, cfg.exchange.fee_rate)
        self.risk = RiskManager(cfg.risk, RiskState(**journal.load_state("risk", {})))
        self.positions: dict[str, Position] = {
            s: Position.from_dict(d) for s, d in journal.load_state("positions", {}).items()}
        self.llm_views: dict[str, tuple[str, float, float]] = {}
        self.last_scanned_bar: dict[str, float] = {}
        self._stop = False
        if isinstance(broker, PaperBroker):
            pb = journal.load_state("paper_broker")
            if pb:
                broker.cash, broker.holdings = pb["cash"], pb["holdings"]
        if self.positions:
            log.info("restored %d open position(s): %s", len(self.positions), list(self.positions))

    # ------------------------------------------------------------------ utils
    def persist(self) -> None:
        self.j.save_state("positions", {s: p.to_dict() for s, p in self.positions.items()})
        self.j.save_state("risk", asdict(self.risk.s))
        if isinstance(self.broker, PaperBroker):
            self.j.save_state("paper_broker", {"cash": self.broker.cash, "holdings": self.broker.holdings})

    def equity(self) -> float:
        prices = {s: self.broker.last_price(s) for s in self.positions}
        return self.broker.equity(prices)

    def _frames(self, symbol: str, closed_only=True):
        x = self.cfg.exchange
        edf = enrich(self.broker.fetch_ohlcv(symbol, x.entry_timeframe, x.candles, closed_only))
        tdf = enrich(self.broker.fetch_ohlcv(symbol, x.trend_timeframe, x.candles))
        return edf, tdf

    # ------------------------------------------------------------------ entries
    def scan(self) -> None:
        eq = self.equity()
        self.risk.on_equity(eq)
        btc_tdf = None
        if self.cfg.entry.btc_filter:
            btc_tdf = enrich(self.broker.fetch_ohlcv("BTC/USDT", self.cfg.exchange.trend_timeframe,
                                                     self.cfg.exchange.candles))
        for sym in self.cfg.exchange.symbols:
            if sym in self.positions:
                continue
            ok, why = self.risk.can_open(sym, len(self.positions), eq)
            if not ok:
                log.info("no new entries: %s", why)
                return
            try:
                edf, tdf = self._frames(sym)
            except Exception as exc:
                log.warning("%s data error: %s", sym, exc)
                continue
            bar_ts = edf.index[-1].timestamp()
            if self.last_scanned_bar.get(sym) == bar_ts:
                continue  # already judged this closed candle
            self.last_scanned_bar[sym] = bar_ts

            setup = evaluate_entry(sym, edf, tdf, self.cfg, btc_tdf)
            log.info("%-10s score %5.1f  R:R %.2f  %s", sym, setup.score, setup.reward_risk,
                     ("BLOCKED: " + "; ".join(setup.blockers)) if setup.blockers else "")
            if setup.blockers or setup.score < self.cfg.entry.min_tech_score:
                continue

            verdict = self.llm.analyze_entry(
                market_snapshot(sym, edf, tdf, self.cfg.exchange.entry_timeframe,
                                self.cfg.exchange.trend_timeframe),
                {"tech_score": setup.score, "entry": setup.price, "stop": round(setup.stop, 8),
                 "target": round(setup.target, 8), "reward_risk": round(setup.reward_risk, 2),
                 "tech_reasons": setup.reasons})
            self.j.event(sym, "entry_analysis", {"score": setup.score, "reasons": setup.reasons,
                                                 "llm": asdict(verdict) if verdict else None})
            if verdict is None:
                if self.cfg.entry.require_llm:
                    log.warning("%s: LLM gave no verdict — skipping (require_llm)", sym)
                    continue
            elif not verdict.buy or verdict.confidence < self.cfg.entry.min_llm_confidence:
                log.info("%s: LLM vetoed (%s %.2f) risks=%s", sym, "BUY" if verdict.buy else "SKIP",
                         verdict.confidence, verdict.risks)
                continue
            self.open_trade(setup, verdict, eq)
            eq = self.equity()

    def open_trade(self, setup, verdict, equity: float) -> None:
        qty = self.risk.position_size(setup.price, setup.stop, equity, self.broker.free_quote())
        if qty <= 0:
            log.info("%s: size too small / no balance", setup.symbol)
            return
        fill = self.broker.market_buy(setup.symbol, qty)
        # re-anchor stop to the actual fill keeping the planned risk distance
        stop = fill.price - (setup.price - setup.stop)
        p = Position(symbol=setup.symbol, entry_price=fill.price, initial_entry=fill.price, qty=fill.qty,
                     initial_qty=fill.qty, initial_stop=stop, stop=stop, fees_paid=fill.fee,
                     entry_fees=fill.fee,
                     entry_notes="; ".join(setup.reasons + (verdict.reasons if verdict else [])))
        if self.cfg.management.use_exchange_stop:
            p.exchange_stop_id = self.broker.place_stop(p.symbol, p.qty, p.stop)
            p.exchange_stop_price = p.stop
        self.positions[p.symbol] = p
        self.persist()
        msg = (f"ENTER {p.symbol} qty {p.qty:.6g} @ {fill.price:.6g} stop {stop:.6g} "
               f"(risk {p.initial_risk_amount:.2f} {self.cfg.exchange.quote_asset})")
        log.info("🟢 %s", msg)
        self.j.event(p.symbol, "enter", msg)

    # ------------------------------------------------------------------ monitoring
    def manage_all(self) -> None:
        for sym in list(self.positions):
            try:
                self.manage(self.positions[sym])
            except Exception as exc:
                log.exception("%s manage error: %s", sym, exc)
        self.persist()

    def manage(self, p: Position) -> None:
        # 1) did the exchange-side stop already fire?
        f = self.broker.stop_filled(p.symbol, p.exchange_stop_id)
        if f:
            p.exchange_stop_id = None
            self._finalize(p, f, "exchange stop filled")
            return

        raw, tdf = self._frames(p.symbol, closed_only=False)
        edf, forming = raw.iloc[:-1], raw.iloc[-1]   # indicators on closed bars only
        price = self.broker.last_price(p.symbol)
        bar_ts = edf.index[-1].timestamp()
        new_bar = bar_ts != p.last_bar_ts
        p.last_bar_ts = bar_ts

        btc = None
        if p.symbol != "BTC/USDT":
            btc = enrich(self.broker.fetch_ohlcv("BTC/USDT", self.cfg.exchange.entry_timeframe, 100))
        risk_score, risk_why = deterioration_score(edf, tdf, btc)

        action, conf = self._llm_review(p, edf, tdf, price, risk_score)
        d = self.manager.evaluate(p, price, float(forming.high), float(edf.atr.iloc[-1]),
                                  risk_score, action, conf, new_bar)
        if d.close:
            self.close(p, d.close_reason + (f" | {', '.join(risk_why)}" if risk_why else ""))
            return
        for n in d.notes:
            log.info("%s %s", p.symbol, n)
            p.history.append(f"{time.strftime('%m-%d %H:%M')} {n}")
        if d.add_qty:
            self.broker.cancel_order(p.symbol, p.exchange_stop_id)
            fill = self.broker.market_buy(p.symbol, d.add_qty)
            TradeManager.apply_add(p, fill.qty, fill.price, fill.fee)
            p.exchange_stop_id = None
        if d.partial_qty:
            self.broker.cancel_order(p.symbol, p.exchange_stop_id)
            p.exchange_stop_id = None
            fill = self.broker.market_sell(p.symbol, d.partial_qty)
            pnl = TradeManager.apply_partial(p, fill.qty, fill.price, fill.fee)
            log.info("💰 %s partial %.6g @ %.6g pnl %+.2f", p.symbol, fill.qty, fill.price, pnl)
        moved = d.new_stop and d.new_stop > p.stop
        if moved:
            p.stop, p.stage = d.new_stop, d.stage or p.stage
        if self.cfg.management.use_exchange_stop and not isinstance(self.broker, PaperBroker):
            # re-place the exchange stop when size changed, it is missing, or the
            # software stop moved >0.2% above it (avoids cancel/replace spam)
            drift = p.stop / p.exchange_stop_price - 1 if p.exchange_stop_price else 1
            if p.exchange_stop_id is None or d.add_qty or d.partial_qty or drift > 0.002:
                self.broker.cancel_order(p.symbol, p.exchange_stop_id)
                p.exchange_stop_id = self.broker.place_stop(p.symbol, p.qty, p.stop)
                p.exchange_stop_price = p.stop if p.exchange_stop_id else 0.0

        log.debug("%s px %.6g R %+.2f stop %.6g risk %.0f llm %s", p.symbol, price,
                  p.r_multiple(price), p.stop, risk_score, action)

    def _llm_review(self, p, edf, tdf, price, risk_score):
        now = time.time()
        if now - p.last_llm_review >= self.cfg.loop.llm_review_every_sec:
            p.last_llm_review = now
            v = self.llm.review_position(
                market_snapshot(p.symbol, edf, tdf, self.cfg.exchange.entry_timeframe,
                                self.cfg.exchange.trend_timeframe),
                {"entry": p.entry_price, "price": price, "stop": p.stop,
                 "r_multiple": round(p.r_multiple(price), 2), "max_r": round(p.max_r, 2),
                 "stage": p.stage, "bars_held": p.bars_held, "tech_risk_score": risk_score})
            if v:
                self.llm_views[p.symbol] = (v.action, v.confidence, now)
                self.j.event(p.symbol, "llm_review", asdict(v))
                if v.action != "HOLD":
                    log.info("🤖 %s LLM %s (%.2f): %s", p.symbol, v.action, v.confidence, v.reason)
        view = self.llm_views.get(p.symbol)
        if view and now - view[2] < 2 * self.cfg.loop.llm_review_every_sec:
            return view[0], view[1]
        return None, 0.0

    # ------------------------------------------------------------------ exits
    def close(self, p: Position, reason: str) -> None:
        self.broker.cancel_order(p.symbol, p.exchange_stop_id)
        f = self.broker.stop_filled(p.symbol, p.exchange_stop_id)  # race: stop fired meanwhile?
        if f:
            p.exchange_stop_id = None
            self._finalize(p, f, "exchange stop filled")
            return
        p.exchange_stop_id = None
        fill = self.broker.market_sell(p.symbol, p.qty)
        self._finalize(p, fill, reason)

    def _finalize(self, p: Position, fill: Fill, reason: str) -> None:
        # partial-exit PnL (net of its sell fee) + final leg - final sell fee - all buy fees
        pnl = p.realized_pnl + (fill.price - p.entry_price) * fill.qty - fill.fee - p.entry_fees
        r = pnl / p.initial_risk_amount if p.initial_risk_amount else 0
        emoji = "✅" if pnl > 0 else "🔴"
        log.info("%s EXIT %s @ %.6g pnl %+.2f (%+.2fR) — %s", emoji, p.symbol, fill.price, pnl, r, reason)
        self.j.trade(symbol=p.symbol, opened_at=p.opened_at, closed_at=time.time(), entry=p.entry_price,
                     exit=fill.price, qty=p.initial_qty, pnl=pnl, r_multiple=r, exit_reason=reason,
                     entry_notes=p.entry_notes, history=p.history)
        self.risk.on_trade_closed(p.symbol, pnl)
        self.positions.pop(p.symbol, None)
        self.persist()

    def close_all(self, reason="manual close-all") -> None:
        for p in list(self.positions.values()):
            self.close(p, reason)

    # ------------------------------------------------------------------ main loop
    def run(self) -> None:
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "_stop", True))
        log.info("agent started in %s mode | symbols %s | LLM %s (%s)", self.cfg.mode,
                 self.cfg.exchange.symbols, self.cfg.llm.model,
                 "online" if self.llm.healthy() else "OFFLINE")
        next_scan = 0.0
        try:
            while not self._stop:
                t0 = time.time()
                if self.positions:
                    self.manage_all()
                if t0 >= next_scan:
                    try:
                        self.scan()
                    except Exception as exc:
                        log.exception("scan error: %s", exc)
                    next_scan = t0 + self.cfg.loop.scan_interval_sec
                    log.info("equity %.2f | open %d | %s", self.equity(), len(self.positions),
                             self.j.stats())
                if self.risk.s.halted and self.positions:
                    log.error("%s — flattening all positions", self.risk.s.halt_reason)
                    self.close_all(self.risk.s.halt_reason)
                time.sleep(max(1.0, self.cfg.loop.monitor_interval_sec - (time.time() - t0)))
        except KeyboardInterrupt:
            pass
        finally:
            self.persist()
            log.info("agent stopped. Open positions keep their exchange stops: %s", list(self.positions))
