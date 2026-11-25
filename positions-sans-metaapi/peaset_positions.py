#!/usr/bin/env python3
"""Peaset — Positions ouvertes, sans MetaAPI.

Envoie les positions ouvertes MT5 à Peaset toutes les 60 secondes.
Utilise la bibliothèque MetaTrader5 sur Windows, avec le mot de passe
investisseur en lecture seule (jamais le mot de passe principal).

Usage :
  set MT5_LOGIN=594017
  set MT5_SERVER=FusionMarkets-Demo
  set MT5_INVESTOR_PASSWORD=...
  set PEASET_NAME=Black_peaset
  set MT5_WORKER_SECRET=...
  python peasel_positions.py

Ne mets jamais ton mot de passe dans le code, seulement en variable
d'environnement. Le programme ne trade pas, il lit seulement.
"""

import json
import os
import time
import urllib.request

import MetaTrader5 as mt5

WORKER_URL = "https://peaset-chat.pascalsteeve4.workers.dev/mt5/positions-worker"

LOGIN = int(os.environ.get("MT5_LOGIN", "0"))
SERVER = os.environ.get("MT5_SERVER", "")
PASSWORD = os.environ.get("MT5_INVESTOR_PASSWORD", "")
NAME = os.environ.get("PEASET_NAME", "Black_peaset")
SECRET = os.environ.get("MT5_WORKER_SECRET", "")


def clean_positions(positions):
    out = []
    for p in positions or []:
        out.append({
            "ticket": int(p.ticket),
            "position": int(p.ticket),
            "symbol": p.symbol,
            "type": "sell" if p.type == mt5.POSITION_TYPE_SELL else "buy",
            "volume": float(p.volume),
            "openTime": int(p.time * 1000),
            "openPrice": float(p.price_open),
            "currentPrice": float(p.price_current),
            "profit": float(p.profit),
            "commission": 0.0,
            "swap": float(p.swap),
            "sl": float(p.sl),
            "tp": float(p.tp),
        })
    return out


def send_once():
    positions = mt5.positions_get()
    account = mt5.account_info()
    payload = {
        "name": NAME,
        "account": {
            "login": account.login if account else LOGIN,
            "server": account.server if account else SERVER,
            "balance": float(account.balance) if account else None,
            "equity": float(account.equity) if account else None,
        },
        "positions": clean_positions(positions),
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        WORKER_URL,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + SECRET,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        print(resp.status, resp.read().decode("utf-8", "ignore"))


def main():
    if not mt5.initialize(login=LOGIN, server=SERVER, password=PASSWORD):
        print("MT5 : connexion impossible", mt5.last_error())
        return
    print("MT5 connecté, envoi des positions ouvertes toutes les 60 s…")
    try:
        while True:
            try:
                send_once()
            except Exception as exc:  # noqa: BLE001
                print("Erreur d'envoi :", exc)
            time.sleep(60)
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
