"""SQLite journal: every trade, every decision, plus crash-safe agent state."""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path


class Journal:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS trades(
            id INTEGER PRIMARY KEY, symbol TEXT, opened_at REAL, closed_at REAL,
            entry REAL, exit REAL, qty REAL, pnl REAL, r_multiple REAL,
            exit_reason TEXT, entry_notes TEXT, history TEXT);
        CREATE TABLE IF NOT EXISTS events(ts REAL, symbol TEXT, kind TEXT, payload TEXT);
        CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);
        """)

    def event(self, symbol: str, kind: str, payload: dict | str) -> None:
        self.db.execute("INSERT INTO events VALUES(?,?,?,?)",
                        (time.time(), symbol, kind, json.dumps(payload, default=str)))
        self.db.commit()

    def trade(self, **t) -> None:
        self.db.execute("""INSERT INTO trades(symbol,opened_at,closed_at,entry,exit,qty,pnl,r_multiple,
                           exit_reason,entry_notes,history) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                        (t["symbol"], t["opened_at"], t["closed_at"], t["entry"], t["exit"], t["qty"],
                         t["pnl"], t["r_multiple"], t["exit_reason"], t["entry_notes"],
                         json.dumps(t.get("history", []))))
        self.db.commit()

    def save_state(self, key: str, value) -> None:
        self.db.execute("INSERT OR REPLACE INTO state VALUES(?,?)", (key, json.dumps(value, default=str)))
        self.db.commit()

    def load_state(self, key: str, default=None):
        row = self.db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def stats(self) -> dict:
        rows = self.db.execute("SELECT pnl, r_multiple FROM trades").fetchall()
        if not rows:
            return {"trades": 0}
        wins = [r for r in rows if r[0] > 0]
        gross_w = sum(r[0] for r in wins)
        gross_l = -sum(r[0] for r in rows if r[0] <= 0)
        return {"trades": len(rows), "win_rate": len(wins) / len(rows),
                "net_pnl": sum(r[0] for r in rows),
                "profit_factor": gross_w / gross_l if gross_l else float("inf"),
                "avg_r": sum(r[1] for r in rows) / len(rows)}
