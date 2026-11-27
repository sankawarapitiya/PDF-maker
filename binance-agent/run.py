#!/usr/bin/env python3
"""CLI for the agentic Binance trader.

  python run.py check                      # config, exchange & LLM connectivity
  python run.py run                        # start the agent (mode from config.yaml)
  python run.py status                     # open positions + journal stats
  python run.py close-all                  # flatten everything now
  python run.py backtest --symbol BTC/USDT --days 120 [--with-llm]
  python run.py backtest --synthetic       # offline demo, no network
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

from agent.config import load_config


def setup_logging(log_dir: str, verbose: bool) -> None:
    Path(log_dir).mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)-7s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout),
                  logging.FileHandler(Path(log_dir) / "agent.log", encoding="utf-8")])
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def make_broker(cfg):
    from agent.broker import BinanceBroker, PaperBroker
    if cfg.mode == "paper":
        return PaperBroker(cfg.risk.starting_equity, cfg.exchange.fee_rate, cfg.exchange.slippage,
                           cfg.exchange.quote_asset)
    return BinanceBroker(cfg.api_key, cfg.api_secret, testnet=cfg.mode == "testnet",
                         quote=cfg.exchange.quote_asset)


def make_agent(cfg):
    from agent.agent import TradingAgent
    from agent.journal import Journal
    from agent.llm import LocalLLM
    return TradingAgent(cfg, make_broker(cfg), LocalLLM(cfg.llm), Journal(cfg.storage.db_path))


def fetch_history(symbol: str, tf: str, days: int):
    import ccxt
    import pandas as pd
    ex = ccxt.binance({"enableRateLimit": True})
    since = ex.milliseconds() - days * 86400_000
    rows = []
    while True:
        batch = ex.fetch_ohlcv(symbol, tf, since=since, limit=1000)
        if not batch:
            break
        rows += batch
        since = batch[-1][0] + 1
        if len(batch) < 1000:
            break
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"]).drop_duplicates("ts")
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    return df.set_index("ts").astype(float)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["check", "run", "status", "close-all", "backtest"])
    ap.add_argument("--config", default="config.yaml")
    ap.add_argument("--symbol", default="BTC/USDT")
    ap.add_argument("--days", type=int, default=120)
    ap.add_argument("--csv", help="backtest on a local OHLCV csv (ts,open,high,low,close,volume)")
    ap.add_argument("--synthetic", action="store_true", help="backtest on generated data (offline)")
    ap.add_argument("--with-llm", action="store_true", help="use the local LLM in the backtest (slow)")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()

    cfg = load_config(a.config)
    setup_logging(cfg.storage.log_dir, a.verbose)
    log = logging.getLogger("cli")

    if a.command == "check":
        from agent.llm import LocalLLM
        llm = LocalLLM(cfg.llm)
        print(f"mode           : {cfg.mode}")
        print(f"LLM {cfg.llm.model:<11}: {'OK' if llm.healthy() else 'NOT REACHABLE at ' + cfg.llm.base_url}")
        b = make_broker(cfg)
        print(f"exchange       : OK, BTC/USDT = {b.last_price('BTC/USDT')}")
        print(f"free {cfg.exchange.quote_asset:<10}: {b.free_quote():.2f}")
        if llm.healthy():
            t = time.time()
            print("LLM JSON test  :", llm.chat('Reply with JSON {"ok": true}', "ping"),
                  f"({time.time() - t:.1f}s)")
    elif a.command == "run":
        make_agent(cfg).run()
    elif a.command == "status":
        from agent.journal import Journal
        j = Journal(cfg.storage.db_path)
        print(json.dumps({"positions": j.load_state("positions", {}), "risk": j.load_state("risk", {}),
                          "stats": j.stats()}, indent=2, default=str))
    elif a.command == "close-all":
        make_agent(cfg).close_all()
    elif a.command == "backtest":
        import pandas as pd
        from agent.backtest import backtest, synthetic_ohlcv
        if a.synthetic:
            df = synthetic_ohlcv()
        elif a.csv:
            df = pd.read_csv(a.csv, parse_dates=["ts"], index_col="ts")
        else:
            log.info("downloading %d days of %s %s ...", a.days, a.symbol, cfg.exchange.entry_timeframe)
            df = fetch_history(a.symbol, cfg.exchange.entry_timeframe, a.days)
        llm = None
        if a.with_llm:
            from agent.llm import LocalLLM
            llm = LocalLLM(cfg.llm)
        res = backtest(df, cfg, a.symbol, llm)
        print(json.dumps(res.summary(cfg.risk.starting_equity), indent=2))
        for t in res.trades[-15:]:
            print(f"{t['opened'] if isinstance(t['opened'], str) else time.strftime('%Y-%m-%d %H:%M', time.gmtime(t['opened']))}"
                  f"  {t['r']:+6.2f}R  max {t['max_r']:+5.2f}R  {t['reason']}")


if __name__ == "__main__":
    main()
