# Positions ouvertes Peaset — système maison, sans MetaAPI

Code écrit par Muse, sans MetaAPI. Aucune limite de 1 compte.
Fonctionne avec n'importe quel broker : ICMarkets, Fusion Markets, GatesFX, etc.

## Les 3 fichiers

- `peaset_positions_worker.js` — module Worker (à fusionner dans `peaset-chat`)
  - `GET /mt5/positions?token=…` : le site lit les positions ouvertes
  - `POST /mt5/positions-worker` : l'EA / le programme Python envoie les positions
  - Stockage KV : `mt5positions:<nom>`, par utilisateur (Black_peaset, etc.)
  - Quand la liste est vide, la clé est supprimée.
- `PeasetPositions.mq5` — Expert Advisor, pas de mot de passe
  - Utilise le terminal MT5 déjà connecté.
  - Envoie les positions ouvertes toutes les 60 secondes.
  - Autoriser WebRequest pour `https://peaset-chat.pascalsteeve4.workers.dev`
  - Paramètres : TraderName, WorkerSecret, WorkerUrl, SyncMinutes.
- `peaset_positions.py` — programme Python, mot de passe investisseur en lecture seule
  - Variables d'environnement : MT5_LOGIN, MT5_SERVER,
    MT5_INVESTOR_PASSWORD, PEASET_NAME, MT5_WORKER_SECRET.
  - Envoie les positions ouvertes toutes les 60 secondes.
  - Ne trade pas, il lit seulement.

## Sur le site

Voir `../positions-ouvertes.md` pour la boîte « Positions ouvertes »
à ajouter dans `#view-mt5`, avant « Trades synchronisés ».
Elle lit `GET /mt5/positions` et se met à jour toutes les 60 secondes.

## Attention, téléphone seul

L'EA et le programme Python ont besoin d'un Windows avec MT5.
Depuis un téléphone seul, sans ordinateur et sans MetaAPI,
les positions ouvertes ne peuvent pas arriver toutes seules.
C'est pour ça que les trades fermés, eux, arrivent après synchro
(moins de 60 secondes), mais les positions ouvertes en direct ont besoin
d'un programme qui tourne quelque part.

Ce système est prêt à installer. Il n'est pas déployé sur le site
en ligne, pour ne pas casser le chat et le journal.
