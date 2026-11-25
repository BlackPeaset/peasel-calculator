# Peaset Calculator — API de synchronisation

Fournie par Muse pour Pascal, le 2026-11-25.
Vérifiée le 2026-11-25 : l'API répond en 200 à la racine,
et en 401 sans token sur `/mt5/deals`, comme prévu.

## Adresses

- Site : https://peaset-calculator.pages.dev
- API : https://peaset-chat.pascalsteeve4.workers.dev

Toutes les réponses sont en JSON. Toutes les routes acceptent
CORS. En cas d'erreur inattendue, le Worker renvoie 503 avec
`{"error": "..."}` et le site réessaie tout seul.

## Authentification

Il y a deux clés différentes, ne les confonds pas :

1. **Token de session Peaset** — pour le site et pour toi.
   Tu l'obtiens en te connectant sur le site, avec
   `POST /account/login` avec ton email et ton mot de passe Peaset.
   Il s'envoie ensuite dans le corps (`{ "token": "..." }`)
   ou en query (`?token=...`).
   Il ne donne accès qu'à ton propre compte.

2. **Secret Worker MT5_WORKER_SECRET** — pour ton programme de synchro.
   Il s'envoie en header `Authorization: Bearer <secret>`
   ou dans le corps (`{ "worker_secret": "..." }`).
   Il donne accès aux routes serveur-à-serveur `/mt5/links`,
   `/mt5/link-get` et `/mt5/sync-worker`.
   Ne l'envoie jamais dans un chat, ne le mets jamais dans GitHub.

Le mot de passe MT5 investisseur est chiffré dans le Worker
avec MT5_LINK_KEY, il n'est jamais renvoyé au site.

## Flux de synchronisation, sans MetaAPI

1. Lier le compte, dans le site : `POST /mt5/link`
2. Cliquer "Synchroniser maintenant" : `POST /mt5/sync-now`
3. Ton programme local (EA ou Python, voir `sync-sans-metaapi/`)
   lit les comptes liés, récupère le mot de passe investisseur,
   lit l'historique MT5, puis pousse les deals : `POST /mt5/sync-worker`
4. Le site lit les deals : `GET /mt5/deals`

## Endpoints MT5

### POST /mt5/link — lier un compte MT5

Auth : token de session.

Corps :
```json
{
  "token": "TON_TOKEN_PEASET",
  "login": "12345678",
  "server": "NomDuServeurMT5",
  "password": "MOT_DE_PASSE_INVESTISSEUR"
}
```

- `login` : numéro de compte MT5, 3 à 20 chiffres.
- `server` : nom exact du serveur MT5, 120 caractères max.
- `password` : mot de passe investisseur, en lecture seule, 6 caractères minimum.
  Jamais le mot de passe principal.

Réponse OK :
```json
{ "ok": true }
```

Erreurs :
- 401 `Connexion requise` — token invalide ou expiré.
- 403 `Compte bloqué par l'administrateur`
- 400 `Numéro de compte, serveur ou mot de passe manquant`
- 503 `Liaison MT5 pas encore activée` — MT5_LINK_KEY manquant dans le Worker.

Le mot de passe est chiffré en AES-GCM et stocké dans KV
`mt5link:<nom>`. Il n'est jamais renvoyé.

### POST /mt5/unlink — délier un compte MT5

Auth : token de session.

Corps : `{ "token": "TON_TOKEN_PEASET" }`

Réponse : `{ "ok": true }`

Supprime `mt5link:<nom>` et `mt5syncnow:<nom>`.

### GET /mt5/links — liste des comptes liés (programme local)

Auth : secret Worker, en header `Authorization: Bearer <secret>`.

```bash
curl -H "Authorization: Bearer TON_SECRET" \
  https://peaset-chat.pascalsteeve4.workers.dev/mt5/links
```

Réponse :
```json
{
  "ok": true,
  "links": [
    {
      "name": "black_peaset",
      "login": "12345678",
      "server": "NomDuServeurMT5",
      "t": 1763980000000,
      "lastSync": 1763980100000
    }
  ]
}
```

Erreur : 401 `Non autorisé` — secret faux ou manquant.

### POST /mt5/link-get — relire un lien MT5 (programme local)

Auth : secret Worker.

Corps :
```json
{
  "name": "black_peaset",
  "worker_secret": "TON_SECRET"
}
```

Réponse :
```json
{
  "ok": true,
  "login": "12345678",
  "server": "NomDuServeurMT5",
  "password": "MOT_DE_PASSE_INVESTISSEUR"
}
```

Erreurs :
- 401 `Non autorisé`
- 404 `Aucun compte MT5 lié`
- 503 `Liaison MT5 pas encore activée`

### POST /mt5/sync-now — demander une synchro

Auth : token de session.

Corps : `{ "token": "TON_TOKEN_PEASET" }`

Réponse : `{ "ok": true }`

Met un drapeau dans KV `mt5syncnow:<nom>`. Ton programme local
le voit et synchronise.

Erreur : 404 `Aucun compte MT5 lié` — lie d'abord un compte.

### GET /mt5/sync-status — état de la synchro

Auth : token de session, en query.

```bash
curl "https://peaset-chat.pascalsteeve4.workers.dev/mt5/sync-status?token=TON_TOKEN_PEASET"
```

Réponse :
```json
{
  "ok": true,
  "linked": true,
  "lastSync": 1763980100000,
  "pendingSyncNow": false
}
```

- `linked` : un compte MT5 est lié.
- `lastSync` : timestamp en millisecondes de la dernière synchro réussie, ou null.
- `pendingSyncNow` : true si une synchro a été demandée après la dernière synchro.

### GET /mt5/deals — lire les deals synchronisés

Auth : token de session, en query.

```bash
curl "https://peaset-chat.pascalsteeve4.workers.dev/mt5/deals?token=TON_TOKEN_PEASET"
```

Réponse :
```json
{
  "ok": true,
  "deals": [
    {
      "ticket": 123456789,
      "position": 123456789,
      "symbol": "EURUSD",
      "type": "buy",
      "volume": 0.10,
      "openTime": 1763970000000,
      "closeTime": 1763973600000,
      "openPrice": 1.08500,
      "closePrice": 1.08600,
      "profit": 10.00,
      "commission": -0.70,
      "swap": 0.00
    }
  ],
  "account": {
    "account": 12345678,
    "server": "NomDuServeurMT5",
    "balance": 1000.00,
    "equity": 1010.00,
    "t": 1763980100000
  }
}
```

- `deals` : triés par `closeTime` décroissant, 300 max gardés.
- `account` : null si aucune synchro n'a encore envoyé le solde.
- `openTime` / `closeTime` : en millisecondes, 0 si inconnu.
- `type` : `buy` ou `sell`.

Erreur : 401 `Connexion requise` — c'est la réponse vue le 2026-11-25
sans token, et c'est normal.

### POST /mt5/sync-worker — pousser les deals (programme local)

Auth : secret Worker.

Corps :
```json
{
  "name": "black_peaset",
  "worker_secret": "TON_SECRET",
  "deals": [
    {
      "ticket": 123456789,
      "position": 123456789,
      "symbol": "EURUSD",
      "type": "buy",
      "volume": 0.10,
      "openTime": 1763970000000,
      "closeTime": 1763973600000,
      "openPrice": 1.08500,
      "closePrice": 1.08600,
      "profit": 10.00,
      "commission": -0.70,
      "swap": 0.00
    }
  ],
  "account": 12345678,
  "server": "NomDuServeurMT5",
  "balance": 1000.00,
  "equity": 1010.00
}
```

- `deals` : 200 max par appel. Les deals sont nettoyés et
  fusionnés par ticket, sans doublon, 300 max gardés dans KV
  `mt5deals:<nom>`.
- `account` / `server` / `balance` / `equity` : optionnels, mais
  recommandés. Ils sont stockés dans KV `mt5account:<nom>`.

Réponse :
```json
{ "ok": true, "added": 5, "total": 42 }
```

- `added` : nouveaux deals ajoutés.
- `total` : total gardé après fusion.

Cas spécial : si le corps contient `"masterPassword": true`,
le Worker supprime le lien MT5. C'est une protection : si un
mot de passe principal a été mis par erreur, le lien est détruit
au lieu d'être utilisé.

Erreurs :
- 401 `Non autorisé`
- 404 `Aucun compte MT5 lié`
- 400 `JSON invalide` / `Nom manquant`

## Endpoints compte (pour obtenir ton token)

### POST /account/login

Corps : `{ "email": "...", "password": "..." }`
Réponse : session avec un token, à réutiliser dans les appels MT5.

### POST /account/register

Corps : `{ "email": "...", "password": "..." }`
Envoie un code de vérification par email, à confirmer avec
`POST /account/verify` avec `{ "email": "...", "code": "..." }`.

## Exemple complet en curl

```bash
API=https://peaset-chat.pascalsteeve4.workers.dev

# 1. Lier un compte (token de session)
curl -X POST $API/mt5/link \
  -H "Content-Type: application/json" \
  -d '{"token":"TON_TOKEN","login":"12345678","server":"NomDuServeurMT5","password":"MOT_INVESTISSEUR"}'

# 2. Demander une synchro
curl -X POST $API/mt5/sync-now \
  -H "Content-Type: application/json" \
  -d '{"token":"TON_TOKEN"}'

# 3. Voir l'état
curl "$API/mt5/sync-status?token=TON_TOKEN"

# 4. Lire les deals
curl "$API/mt5/deals?token=TON_TOKEN"
```

## Fichiers liés

- `sync-sans-metaapi/PeasetSync.mq5` : Expert Advisor MT5, sans mot de passe.
- `sync-sans-metaapi/peaset_sync.py` : programme Python, avec mot de passe investisseur.
- `sync-sans-metaapi/README.md` : guide d'installation des deux.
- `peaset-api-client.py` : client Python prêt à l'emploi pour cette API.
- `index.html` : copie du site déployé, qui appelle déjà ces endpoints.
