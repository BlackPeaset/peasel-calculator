# Peaset Calculator

Journal de trading, comme Sage, avec synchronisation MT5.
Site live : https://peaset-calculator.pages.dev

## Contenu
- `index.html` — site Peaset (calculatrice, journal, MT5, Positions ouvertes, 60 secondes)
- `worker.js` — Worker Cloudflare peasel-chat (chat, MT5 deals + positions, sans MetaAPI)
- `positions-sans-metaapi/` — système Positions ouvertes maison, sans MetaAPI
- `sync-sans-metaapi/` — système synchro trades fermés maison, sans MetaAPI
- `peaset-api.md` — documentation API Peaset
- `csv_to_peaset.py` + `modele-historique-mt5.csv` — import CSV depuis le téléphone

## Attention
Ne mets jamais de mot de passe, de token, ou de secret dans ce dépôt.
Le mot de passe investisseur MT5 se met seulement dans le site Peaset, jamais ici, jamais dans le code.

## Déploiement
Cloudflare Pages (projet peasel-calculator) + Cloudflare Worker (peasel-chat).
Les déploiements actuels sont des envois directs, pas encore liés à GitHub.
