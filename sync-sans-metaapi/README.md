# Peaset — Système de synchronisation, sans MetaAPI

Écrit par Muse pour Pascal, le 2026-11-25.

## Ce que c'est

Le même système que MetaAPI, mais fait maison, sans service externe.
Comme Sage, il enregistre automatiquement tes trades fermés :
symbole, sens, volume, entrée, sortie, profit, commission, swap,
solde et équité. Il ne passe jamais d'ordre.

Ton Worker peasel-chat sait déjà recevoir ces deals, sans rien changer :
- `POST /mt5/link` : lie un compte avec le mot de passe investisseur, chiffré
- `POST /mt5/sync-now` : demande une synchro depuis le site
- `GET /mt5/sync-status` : dit si un compte est lié et quand il a sync
- `GET /mt5/deals` : liste les deals pour le journal
- `POST /mt5/sync-worker` : reçoit les deals, avec le secret MT5_WORKER_SECRET
- `POST /mt5/link-get` et `GET /mt5/links` : pour le programme local, avec le même secret

Ce dossier ajoute la pièce qui manquait : le programme local qui
lit ton MT5 et pousse les deals vers le Worker.

## Choisis une méthode

### Méthode 1 — Expert Advisor, la plus simple et la plus sûre (recommandée)

Fichier : `PeasetSync.mq5`

- Pas de mot de passe à donner. L'EA utilise le compte déjà connecté dans ton terminal.
- Marche avec n'importe quel broker, y compris GatesFX.
- Il ne voit jamais ton mot de passe, il ne peut pas trader.

Installation :
1. Copie `PeasetSync.mq5` dans MQL5 > Experts, compile avec F7.
2. Dans MT5, Outils > Options > Expert Advisors, autorise le trading
   algorithmique et les WebRequest, et ajoute cette URL :
   `https://peaset-chat.pascalsteeve4.workers.dev`
3. Glisse l'EA sur un graphique.
4. Paramètres : `TraderName` = ton nom Peaset en minuscules,
   `WorkerSecret` = ton secret MT5_WORKER_SECRET.
5. Il envoie les deals toutes les 60 secondes.

### Méthode 2 — Programme Python, si tu préfères ne pas mettre d'EA

Fichier : `peaset_sync.py`

- Il utilise le mot de passe investisseur, en lecture seule, déjà
  lié dans le site avec `/mt5/link`.
- Il tourne sur Windows, là où MT5 est installé.

Installation :
1. `pip install MetaTrader5 requests`
2. Mets en variables d'environnement :
   `PEASET_WORKER_URL=https://peaset-chat.pascalsteeve4.workers.dev`
   `PEASET_WORKER_SECRET=ton secret MT5_WORKER_SECRET`
3. Lance : `python peasel_sync.py`
4. Il vérifie toutes les 60 secondes s'il y a des comptes liés, et il sync.

## Sécurité

- Jamais le mot de passe principal, seulement l'investisseur, en lecture seule.
- Le secret MT5_WORKER_SECRET ne sort jamais de ton ordinateur.
  Ne l'envoie jamais dans un chat, ne le mets jamais dans GitHub.
- Les deals sont dédupliqués par ticket dans le Worker, 300 max gardés.
- Pour supprimer un compte, utilise "Délier" dans le site, ou
  `POST /mt5/unlink` avec ton token de session.

## Vérifier que ça marche

1. Lie ton compte dans le site Peaset, partie MT5.
2. Lance l'EA ou le programme Python.
3. Clique sur "Synchroniser maintenant" dans le site.
4. Attends 1 minute, puis recharge : tes trades doivent apparaître
   dans le journal, le calendrier et les stats.
5. Dans ton KV Peaset-chat, tu dois voir apparaître des clés
   `mt5link:<nom>`, `mt5deals:<nom>`, `mt5syncstate:<nom>`.

Le 2026-11-25, le KV avait 48 clés et 0 clé MT5 : aucune synchro
n'était encore arrivée dans Peaset. Après la première synchro,
ces clés doivent apparaître.
