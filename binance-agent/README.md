# Agentic Binance Trader (local LLM)

An autonomous **spot** trading agent for Binance that:

1. **Finds entries.** A deterministic multi-timeframe confluence engine pre-screens setups, and a **local LLM** (Ollama, LM Studio, llama.cpp or vLLM) acts as a skeptical second opinion before any buy.
2. **Monitors every open trade** every few seconds, both technically and with periodic LLM reviews.
3. **Locks in profit and lets winners run** with a break-even move, a profit-lock ladder, an ATR chandelier trail, partial take-profit and optional risk-neutral pyramiding.
4. **Exits automatically when the trade turns risky.** A deterioration score and LLM risk alerts can close a trade before the stop is hit.
5. **Protects the account** with fixed-fractional sizing, a daily loss limit, a drawdown kill switch, a losing-streak pause, and a real stop order on Binance in case the bot crashes.

> ⚠️ **Read this first.** No bot guarantees profit, and an LLM does not predict prices. This system's edge comes from **risk control and trade management**, not from prediction. Run it in `paper` mode first, then `testnet`, and check the results yourself before risking money you can afford to lose. Never enable withdrawal permission on the API key.

---

## Architecture

```
                ┌────────────────────────── every scan_interval ─────────────────────────┐
 Binance ──OHLCV──► indicators ──► TECH ANALYST (score 0-100, stop, target, R:R, gates)   │
 (ccxt)           (EMA/RSI/ATR/      │ score ≥ 65, no blockers, R:R ≥ 2                    │
                  MACD/ADX/BB/vol)   ▼                                                    │
                               LOCAL LLM "devil's advocate"  ── SKIP / low conf ──► no trade
                                     │ BUY, conf ≥ 0.65                                   │
                                     ▼                                                    │
                    RISK MANAGER: halt? daily loss? streak? cooldown? → size = 1% risk    │
                                     ▼                                                    │
                    BROKER: market buy  +  STOP_LOSS_LIMIT on exchange (crash safety)     │
                └─────────────────────────────────────────────────────────────────────────┘
                ┌────────────────────────── every monitor_interval ──────────────────────┐
                │  exchange stop filled?  → record exit                                   │
                │  deterioration score (closed bars)  +  LLM review (every 5 min)         │
                │  TRADE MANAGER (pure state machine, shared with the backtester):        │
                │     stop hit → exit       risk ≥ 70 → exit     LLM CLOSE + tech → exit  │
                │     +1R → break-even      +1.5/2/3/4R → lock 0.5/1/1.8/2.8R             │
                │     +2R → bank 33%, chandelier trail 2.5×ATR (1.3× when weakening)      │
                │     risk ≥ 45 or LLM TIGHTEN → stop to price − 1×ATR                    │
                │     optional pyramid add while total risk ≤ initial risk                │
                │  stop only ratchets UP → re-placed on exchange                          │
                └─────────────────────────────────────────────────────────────────────────┘
                         SQLite journal: trades, LLM verdicts, state (restart-safe)
```

### Design principles

| Principle | Why |
|---|---|
| **The LLM filters, it never decides alone** | Small local models hallucinate. Indicators generate the candidates, and the LLM can only *veto* an entry or *reduce* risk (tighten or close). It can never widen a stop, size a position, or open a trade by itself. |
| **Unparsable LLM output means no opinion** | Strict JSON is required. If the LLM is down, `require_llm: true` blocks new entries, but exits keep working on rules alone. |
| **Risk is fixed before entry** | Size = `equity × 1% / (entry − stop)`. A full stop-out costs about 1R, so losing streaks are survivable. |
| **The stop only moves up** | The stop is a ratchet. Profit, once locked, is never given back. |
| **Closed candles only** | Signals and the deterioration score use closed bars, so intrabar noise doesn't trigger whipsaw exits. Stop checks use the live price. |
| **Two layers of stops** | The software stop handles the smart logic. The exchange `STOP_LOSS_LIMIT` order protects you if your PC, internet or the LLM dies. |
| **One engine for live and backtest** | `TradeManager` and `evaluate_entry` are shared, so backtest results reflect the same logic that runs live. |

---

## Entry logic (long only, spot)

**Hard gates (any one blocks the trade):** the higher timeframe is in a downtrend; ATR% is above `max_atr_pct`; BTC's higher timeframe is bearish (for alts); RSI is above 78; there is a bearish RSI divergence; R:R to the nearest resistance is below 2.

**Confluence score (0-100):**

| Signal | Points |
|---|---|
| HTF trend: close > EMA50 > EMA200, EMA50 rising | 20 |
| HTF ADX > 20 | 5 |
| Entry TF EMA21 > EMA50, price > EMA50 | 15 |
| Pullback to EMA21 that bounced, *or* a 20-bar breakout on volume | 15 / 12 |
| RSI 45-68 and rising | 10 |
| MACD histogram improving (+5 on a cross above 0) | 7-12 |
| Bullish candle on >1.2× volume | 10 |
| Close in the upper 40% of the candle's range | 5 |
| Entry TF ADX > 20 | 5 |

**Stop:** the lower of the swing low (10 bars) − 0.25·ATR and entry − 1.8·ATR, but never wider than 3.5·ATR.

**LLM prompt:** the model is told to *look for reasons not to trade*: exhaustion, distribution, fake breakouts, overextension.

## Exit logic

**Deterioration score (0-100) while in a trade:**

| Signal | Points |
|---|---|
| Close below EMA21 | 20 |
| Close below EMA50 | 20 |
| MACD histogram negative and falling | 15 |
| RSI < 45 | 10 |
| RSI collapsed from above 70 | 10 |
| Bearish divergence | 15 |
| Bearish candle with a body > 1.5×ATR | 15 |
| Selling volume spike | 10 |
| HTF lost EMA50 | 15 |
| BTC dumping | 15 |

What happens next depends on the score:

* **≥ 45:** tighten (stop to price − 1·ATR, or a tight trail).
* **≥ 70:** close immediately.
* **LLM `CLOSE`:** acted on only if confidence ≥ 0.9, or confidence ≥ 0.7 *and* the technical score is ≥ 45.
* **Time stop:** close if the trade hasn't reached +0.5R after 48 bars (12 h on 15m).

---

## Setup

```bash
cd binance-agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.example.yaml config.yaml
cp .env.example .env            # only needed for testnet/live
```

### Local LLM (Ollama)

```bash
# https://ollama.com/download
ollama pull qwen2.5:14b-instruct     # ~9 GB, good JSON discipline (needs ~12 GB RAM/VRAM)
# smaller machines: ollama pull qwen2.5:7b-instruct   or   llama3.1:8b
ollama serve                          # http://localhost:11434
```

For LM Studio or a llama.cpp server, set `llm.provider: openai_compatible` and `llm.base_url: http://localhost:1234`.

### Run

```bash
python run.py check                                   # connectivity: Binance + LLM + JSON test
python run.py backtest --symbol ETH/USDT --days 180   # tech-only backtest on real history
python run.py backtest --symbol ETH/USDT --days 30 --with-llm   # include LLM filter (slow)
python run.py backtest --synthetic                    # offline demo on generated data
python run.py run                                     # start the agent (mode from config.yaml)
python run.py status                                  # open positions, risk state, stats
python run.py close-all                               # emergency flatten
python -m pytest -q                                   # 21 tests
```

To keep it running 24/7, use `tmux`, `systemd` or `nohup python run.py run &`. Logs go to `logs/agent.log` and the journal to `state/journal.db`. Restarts restore open positions.

---

## Going live: a safe checklist

1. **Paper for 2-4 weeks** (`mode: paper`) on real prices. Check `status`: you want a profit factor > 1.3 and avg R > 0.2 over **50+ trades**.
2. **Testnet** (`mode: testnet`, keys from https://testnet.binance.vision). This checks real order flow, the exchange stop and fee handling.
3. **Live with small size.** Create an API key with **Spot trading only, no withdrawals, IP-restricted**. Set `CONFIRM_LIVE_TRADING=YES` in `.env`, and use `risk_per_trade: 0.005` for the first month.
4. Never move a stop down by hand, and don't add symbols with thin liquidity.

## Tuning tips

* **Choppy markets:** raise `min_tech_score` (70-75) and use `entry_timeframe: 1h`.
* **Strong trends:** enable `pyramiding` and raise `trail_atr_mult` to 3.0.
* **Too many early exits:** raise `risk_tighten_score` and `risk_exit_score` by 10.
* **Slow LLM:** use a 7B model, raise `llm_review_every_sec`, and keep `require_llm: true`.
* Always re-run the backtest after any change. Optimise on one period and confirm on a different one to avoid overfitting.

## Project layout

```
agent/
  config.py      typed YAML config + validation + secret loading
  indicators.py  EMA, RSI, ATR, MACD, ADX, Bollinger, divergence, swings
  analyst.py     entry confluence scoring, deterioration score, LLM snapshot
  llm.py         Ollama / OpenAI-compatible client, prompts, strict JSON parsing
  position.py    Position + TradeManager (break-even, ladder, trail, exits, pyramid)
  risk.py        sizing, daily loss, drawdown kill switch, streak pause, cooldowns
  broker.py      PaperBroker (simulated) / BinanceBroker (ccxt, exchange stops)
  journal.py     SQLite trades, events, state
  agent.py       orchestration loop
  backtest.py    no-look-ahead backtester + synthetic data generator
run.py           CLI
tests/           unit + integration tests
```

## Limitations and next steps

* Spot long-only. Shorting needs futures (`defaultType: future`, reduce-only stops, funding and liquidation logic).
* Binance can be geo-restricted. Use the regional endpoint that applies to you, and check your local regulations.
* Possible upgrades: a news and sentiment feed for the LLM, a correlation-aware portfolio cap, a Telegram alert and kill command, and walk-forward optimisation.
