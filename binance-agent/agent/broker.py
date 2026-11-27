"""Exchange access. PaperBroker simulates fills on real Binance market data;
BinanceBroker trades spot (testnet or live) via ccxt and keeps a real
STOP_LOSS_LIMIT order on the exchange so a crash of this process never
leaves a position unprotected."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import pandas as pd

log = logging.getLogger("broker")


@dataclass
class Fill:
    price: float
    qty: float      # net quantity actually received / sold
    fee: float      # in quote currency


def _ohlcv_df(rows: list) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    return df.set_index("ts").astype(float)


def _retry(fn, *a, tries=4, **kw):
    for i in range(tries):
        try:
            return fn(*a, **kw)
        except Exception as exc:  # ccxt.NetworkError etc.
            if i == tries - 1 or "Insufficient" in str(exc):
                raise
            log.warning("retry %s after error: %s", getattr(fn, "__name__", fn), exc)
            time.sleep(1.5 * 2 ** i)


class _MarketData:
    def __init__(self, ex):
        self.ex = ex
        self.ex.load_markets()

    def fetch_ohlcv(self, symbol: str, tf: str, limit: int = 300, closed_only: bool = True) -> pd.DataFrame:
        df = _ohlcv_df(_retry(self.ex.fetch_ohlcv, symbol, tf, limit=limit + 1))
        # drop the still-forming candle: signals are only taken on closed bars
        return df.iloc[:-1] if closed_only else df

    def last_price(self, symbol: str) -> float:
        return float(_retry(self.ex.fetch_ticker, symbol)["last"])

    def amount(self, symbol: str, qty: float) -> float:
        return float(self.ex.amount_to_precision(symbol, qty))

    def price_prec(self, symbol: str, price: float) -> float:
        return float(self.ex.price_to_precision(symbol, price))


class PaperBroker(_MarketData):
    """Real prices, simulated money."""

    def __init__(self, starting_equity: float, fee_rate: float, slippage: float, quote: str = "USDT"):
        import ccxt
        super().__init__(ccxt.binance({"enableRateLimit": True}))
        self.cash = starting_equity
        self.fee_rate, self.slip, self.quote = fee_rate, slippage, quote
        self.holdings: dict[str, float] = {}

    def free_quote(self) -> float:
        return self.cash

    def equity(self, prices: dict[str, float]) -> float:
        return self.cash + sum(q * prices.get(s, 0) for s, q in self.holdings.items())

    def market_buy(self, symbol: str, qty: float) -> Fill:
        px = self.last_price(symbol) * (1 + self.slip)
        qty = self.amount(symbol, qty)
        fee = px * qty * self.fee_rate
        self.cash -= px * qty + fee
        self.holdings[symbol] = self.holdings.get(symbol, 0) + qty
        return Fill(px, qty, fee)

    def market_sell(self, symbol: str, qty: float) -> Fill:
        px = self.last_price(symbol) * (1 - self.slip)
        qty = min(self.amount(symbol, qty), self.holdings.get(symbol, 0))
        fee = px * qty * self.fee_rate
        self.cash += px * qty - fee
        self.holdings[symbol] = self.holdings.get(symbol, 0) - qty
        return Fill(px, qty, fee)

    # exchange-side stops are simulated by the agent's monitor loop in paper mode
    def place_stop(self, symbol, qty, stop_price): return None
    def cancel_order(self, symbol, order_id): pass
    def stop_filled(self, symbol, order_id): return None


class BinanceBroker(_MarketData):
    def __init__(self, api_key: str, api_secret: str, testnet: bool, quote: str = "USDT"):
        import ccxt
        ex = ccxt.binance({"apiKey": api_key, "secret": api_secret, "enableRateLimit": True,
                           "options": {"defaultType": "spot", "adjustForTimeDifference": True}})
        if testnet:
            ex.set_sandbox_mode(True)
        super().__init__(ex)
        self.quote = quote

    def free_quote(self) -> float:
        return float(_retry(self.ex.fetch_balance)["free"].get(self.quote, 0.0))

    def equity(self, prices: dict[str, float]) -> float:
        bal = _retry(self.ex.fetch_balance)["total"]
        eq = float(bal.get(self.quote, 0.0))
        for sym, px in prices.items():
            eq += float(bal.get(sym.split("/")[0], 0.0)) * px
        return eq

    def _fill(self, symbol: str, order: dict, side: str) -> Fill:
        if order.get("status") != "closed" or not order.get("filled"):
            order = _retry(self.ex.fetch_order, order["id"], symbol)
        filled, avg = float(order["filled"]), float(order["average"] or order["price"])
        base = symbol.split("/")[0]
        fee_q, net = 0.0, filled
        for f in order.get("fees") or ([order["fee"]] if order.get("fee") else []):
            cost = float(f.get("cost") or 0)
            if f.get("currency") == base:          # fee taken in base asset -> fewer coins
                fee_q += cost * avg
                if side == "buy":
                    net -= cost
            elif f.get("currency") == self.quote:
                fee_q += cost
            # BNB fees: not deducted from position; small, ignored in quote PnL
        return Fill(avg, self.amount(symbol, net), fee_q)

    def market_buy(self, symbol: str, qty: float) -> Fill:
        o = _retry(self.ex.create_order, symbol, "market", "buy", self.amount(symbol, qty))
        return self._fill(symbol, o, "buy")

    def market_sell(self, symbol: str, qty: float) -> Fill:
        free = float(_retry(self.ex.fetch_balance)["free"].get(symbol.split("/")[0], 0.0))
        o = _retry(self.ex.create_order, symbol, "market", "sell", self.amount(symbol, min(qty, free)))
        return self._fill(symbol, o, "sell")

    def place_stop(self, symbol: str, qty: float, stop_price: float) -> str | None:
        """Protective STOP_LOSS_LIMIT; limit 0.5% below trigger so it fills in fast moves."""
        try:
            o = self.ex.create_order(symbol, "STOP_LOSS_LIMIT", "sell", self.amount(symbol, qty),
                                     self.price_prec(symbol, stop_price * 0.995),
                                     {"stopPrice": self.price_prec(symbol, stop_price),
                                      "timeInForce": "GTC"})
            return o["id"]
        except Exception as exc:
            log.error("could not place exchange stop for %s: %s", symbol, exc)
            return None

    def cancel_order(self, symbol: str, order_id: str | None) -> None:
        if not order_id:
            return
        try:
            self.ex.cancel_order(order_id, symbol)
        except Exception as exc:
            log.warning("cancel %s failed (may be filled already): %s", order_id, exc)

    def stop_filled(self, symbol: str, order_id: str | None) -> Fill | None:
        if not order_id:
            return None
        try:
            o = self.ex.fetch_order(order_id, symbol)
        except Exception:
            return None
        return self._fill(symbol, o, "sell") if o.get("status") == "closed" else None
