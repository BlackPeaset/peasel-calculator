"""
Peaset — Convertisseur CSV MT5 vers Peaset.
Écrit par Muse pour Pascal, le 2026-11-25.

Usage :
  python csv_to_peaset.py ton_historique.csv
  python csv_to_peaset.py ton_historique.csv sortie.json

Accepte deux formats :
1. Format Peaset, comme dans modele-historique-mt5.csv :
   ticket,symbol,type,volume,openTime,closeTime,openPrice,closePrice,profit,commission,swap
   avec openTime / closeTime en ISO (2026-11-20T10:00:00Z)
   ou en millisecondes.

2. Format MT5 classique, exporté depuis le terminal ou le broker :
   colonnes avec des noms comme Deal, Time, Type, Symbol,
   Volume, Price, Profit, Commission, Swap, Ticket, etc.
   Le script cherche les colonnes par leur nom, en ignorant
   la casse et les espaces. Il ne garde que les deals
   d'entrée / sortie, pas les lignes de solde.

Sortie : un JSON avec une liste de deals au format Peaset,
prête pour POST /mt5/sync-worker (voir peasel-api.md).
Les deals sont dédupliqués par ticket, triés par closeTime
décroissant, 200 max par appel, comme le Worker.
"""

import csv
import json
import sys
from datetime import datetime, timezone


def parse_time(value):
    value = str(value or "").strip()
    if not value:
        return 0
    # Millisecondes ?
    try:
        n = float(value)
        if n > 1_000_000_000_000:
            return int(n)
        if n > 1_000_000_000:
            return int(n * 1000)
    except ValueError:
        pass
    # ISO ?
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except ValueError:
        pass
    # Formats MT5 courants : 2026.11.20 10:00:00 ou 2026-11-20 10:00:00
    for fmt in ("%Y.%m.%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%d.%m.%Y %H:%M:%S"):
        try:
            dt = datetime.strptime(value, fmt).replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    return 0


def find_col(row, *names):
    lower = {str(k).strip().lower(): v for k, v in row.items() if k is not None}
    for name in names:
        if name in lower:
            return lower[name]
    return ""


def convert(path):
    deals = []
    seen = set()
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ticket_raw = find_col(row, "ticket", "deal", "id", "order")
            try:
                ticket = int(float(str(ticket_raw).strip()))
            except (ValueError, TypeError):
                continue
            if not ticket or ticket in seen:
                continue
            symbol = str(find_col(row, "symbol", "symbole") or "").strip()
            if not symbol:
                continue
            type_raw = str(find_col(row, "type") or "").strip().lower()
            type_ = "sell" if "sell" in type_raw or "vente" in type_raw or type_raw in ("1", "-1") else "buy"
            # MT5 : Type 0 = buy, 1 = sell. Si le type est un chiffre, on le respecte.
            if type_raw in ("0", "1"):
                type_ = "sell" if type_raw == "1" else "buy"
            open_time = parse_time(find_col(row, "opentime", "open time", "open", "time"))
            close_time = parse_time(find_col(row, "closetime", "close time", "close", "time"))
            # Si une seule date est présente, elle sert pour les deux.
            if not open_time and close_time:
                open_time = close_time
            if not close_time and open_time:
                close_time = open_time
            try:
                volume = abs(float(str(find_col(row, "volume") or 0).replace(",", ".")))
            except ValueError:
                volume = 0.0
            try:
                open_price = float(str(find_col(row, "openprice", "open price", "price") or 0).replace(",", "."))
            except ValueError:
                open_price = 0.0
            try:
                close_price = float(str(find_col(row, "closeprice", "close price", "price") or open_price).replace(",", "."))
            except ValueError:
                close_price = open_price
            try:
                profit = float(str(find_col(row, "profit") or 0).replace(",", "."))
            except ValueError:
                profit = 0.0
            try:
                commission = float(str(find_col(row, "commission") or 0).replace(",", "."))
            except ValueError:
                commission = 0.0
            try:
                swap = float(str(find_col(row, "swap") or 0).replace(",", "."))
            except ValueError:
                swap = 0.0
            deals.append({
                "ticket": ticket,
                "position": ticket,
                "symbol": symbol[:30],
                "type": type_,
                "volume": volume,
                "openTime": open_time,
                "closeTime": close_time,
                "openPrice": open_price,
                "closePrice": close_price,
                "profit": profit,
                "commission": commission,
                "swap": swap,
            })
            seen.add(ticket)
    deals.sort(key=lambda d: d["closeTime"], reverse=True)
    return deals[:200]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    deals = convert(sys.argv[1])
    out = {"deals": deals, "total": len(deals)}
    if len(sys.argv) >= 3:
        with open(sys.argv[2], "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f"{len(deals)} deals convertis, sauvés dans {sys.argv[2]}")
    else:
        print(json.dumps(out, ensure_ascii=False, indent=2))
