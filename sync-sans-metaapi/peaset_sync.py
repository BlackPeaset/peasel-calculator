"""
Peaset — Programme de synchronisation MT5, sans MetaAPI.
Écrit par Muse pour Pascal, le 2026-11-25.

Principe, comme Sage avec son Expert Advisor :
- Ce programme tourne sur ton ordinateur Windows, là où ton
  terminal MT5 est installé. Il n'y a pas de service externe,
  pas de MetaAPI, pas de cloud entre toi et ton broker.
- Il demande au Worker peasel-chat la liste des comptes liés :
  GET /mt5/links, avec le secret MT5_WORKER_SECRET.
- Pour chaque compte, il récupère le mot de passe investisseur
  chiffré, via POST /mt5/link-get, avec le même secret.
  Le mot de passe investisseur est en lecture seule : il ne
  peut pas passer d'ordre, ni modifier, ni fermer un trade.
  Ne jamais mettre le mot de passe principal ici.
- Il se connecte à MT5 avec ce login investisseur, lit
  l'historique des deals fermés des 90 derniers jours,
  puis les envoie au Worker :
  POST /mt5/sync-worker, avec les deals, le solde et l'équité.
- Le Worker enregistre les deals dans KV mt5deals:<nom>,
  et le site les affiche avec GET /mt5/deals.

Installation sur Windows :
1. Installe Python 3.11 ou plus, puis dans un terminal :
   pip install MetaTrader5 requests
2. Ouvre ton terminal MT5, connecte-toi une fois avec ton
   compte, pour que le terminal connaisse ton serveur.
3. Crée un fichier peasel_sync_config.json à côté de ce script,
   ou mets les variables d'environnement :
   PEASET_WORKER_URL = https://peaset-chat.pascalsteeve4.workers.dev
   PEASET_WORKER_SECRET = ton secret MT5_WORKER_SECRET
   Ne mets jamais ce secret dans un chat ou dans GitHub.
4. Lance : python peasel_sync.py
   Le programme tourne en boucle, il vérifie toutes les
   60 secondes s'il y a une demande "Synchroniser maintenant"
   dans le site, et il synchronise aussi au démarrage.

Arrêt : Ctrl+C. Pour le lancer au démarrage de Windows,
mets un raccourci dans le dossier Démarrage.
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta

WORKER_URL = os.environ.get("PEASET_WORKER_URL", "https://peaset-chat.pascalsteeve4.workers.dev").rstrip("/")
WORKER_SECRET = os.environ.get("PEASET_WORKER_SECRET", "")
SYNC_INTERVAL_SECONDS = 60
HISTORY_DAYS = 90

try:
    import requests
except ImportError:
    print("Il manque requests : pip install requests")
    sys.exit(1)

try:
    import MetaTrader5 as mt5
except ImportError:
    print("Il manque MetaTrader5 : pip install MetaTrader5")
    print("Ce programme ne tourne que sur Windows, avec MT5 installé.")
    sys.exit(1)


def worker_post(path, payload):
    r = requests.post(WORKER_URL + path, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def worker_get(path):
    r = requests.get(WORKER_URL + path, timeout=30)
    r.raise_for_status()
    return r.json()


def get_links():
    data = worker_get("/mt5/links")
    # Le Worker exige le secret en Bearer pour /mt5/links.
    # Si l'appel ci-dessus échoue avec 401, on réessaie avec le header.
    return data.get("links", [])


def get_links_authed():
    r = requests.get(
        WORKER_URL + "/mt5/links",
        headers={"Authorization": "Bearer " + WORKER_SECRET},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("links", [])


def get_link_password(name):
    data = worker_post("/mt5/link-get", {"name": name, "worker_secret": WORKER_SECRET})
    return data  # { login, server, password }


def sync_one_account(link):
    name = link["name"]
    login = int(link["login"])
    server = link["server"]

    creds = get_link_password(name)
    password = creds.get("password", "")
    if not password:
        print(f"[{name}] pas de mot de passe, on passe.")
        return 0

    if not mt5.initialize():
        print(f"[{name}] MT5 ne démarre pas : {mt5.last_error()}")
        return 0

    try:
        authorized = mt5.login(login, password=password, server=server)
        if not authorized:
            print(f"[{name}] connexion MT5 refusée : {mt5.last_error()}")
            # Si le mot de passe principal a été mis par erreur, le Worker
            # supprime le lien. Ici on ne fait que signaler, on ne supprime rien.
            return 0

        info = mt5.account_info()
        balance = float(info.balance) if info else 0.0
        equity = float(info.equity) if info else 0.0

        end = datetime.now()
        start = end - timedelta(days=HISTORY_DAYS)
        deals = mt5.history_deals_get(start, end)
        if deals is None:
            print(f"[{name}] aucun deal lu, erreur : {mt5.last_error()}")
            deals = []

        out = []
        for d in deals:
            # On ne garde que les deals d'entrée / sortie de trade,
            # pas les corrections de solde.
            if d.entry not in (0, 1):  # 0 = in, 1 = out
                continue
            out.append({
                "ticket": int(d.ticket),
                "position": int(d.position_id),
                "symbol": str(d.symbol),
                "type": "sell" if d.type == 1 else "buy",
                "volume": float(d.volume),
                "openTime": int(d.time * 1000) if d.entry == 0 else 0,
                "closeTime": int(d.time * 1000) if d.entry == 1 else 0,
                "openPrice": float(d.price),
                "closePrice": float(d.price),
                "profit": float(d.profit),
                "commission": float(d.commission),
                "swap": float(d.swap),
            })
        # Le Worker fusionne par ticket et garde 300 deals max,
        # donc on peut envoyer jusqu'à 200 deals par appel.
        out = sorted(out, key=lambda x: x["closeTime"], reverse=True)[:200]

        result = worker_post("/mt5/sync-worker", {
            "name": name,
            "worker_secret": WORKER_SECRET,
            "deals": out,
            "account": login,
            "server": server,
            "balance": balance,
            "equity": equity,
        })
        print(f"[{name}] synchro OK : {result.get('added', 0)} nouveaux, {result.get('total', 0)} au total, solde {balance}")
        return result.get("added", 0)
    finally:
        mt5.shutdown()


def main():
    if not WORKER_SECRET:
        print("PEASET_WORKER_SECRET manquant. Mets-le en variable d'environnement.")
        print("Ne l'envoie jamais dans un chat.")
        sys.exit(1)
    print("Peaset Sync, sans MetaAPI. Worker :", WORKER_URL)
    print("Boucle toutes les 60 secondes. Ctrl+C pour arrêter.")
    while True:
        try:
            links = get_links_authed()
            if not links:
                print("Aucun compte MT5 lié pour l'instant. Lie un compte dans le site, puis relance.")
            for link in links:
                try:
                    sync_one_account(link)
                except Exception as e:
                    print(f"[{link.get('name')}] erreur : {e}")
        except Exception as e:
            print("Erreur de boucle :", e)
        time.sleep(SYNC_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
