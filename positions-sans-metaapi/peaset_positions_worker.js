// Peaset — Positions ouvertes, sans MetaAPI.
// Code maison, écrit par Muse. Aucun appel MetaAPI.
// À fusionner dans le Worker peasel-chat.
// KV : mt5positions:<nom>  (positions ouvertes, par utilisateur)
//      mt5account:<nom>    (déjà utilisé pour les deals fermés)
//
// ATTENTION AUTH : le Worker accepte seulement workerAuthed, c'est-à-dire
// Authorization: Bearer <MT5_WORKER_SECRET> ou body.worker_secret.
// L'en-tête X-Worker-Secret n'est PAS acceptée. L'EA et le programme
// Python de ce dossier utilisent donc Authorization: Bearer.
//
// Endpoints ajoutés :
//   GET  /mt5/positions?token=<session>
//     -> { positions: [...], account, updatedAt }
//   POST /mt5/positions-worker   (auth Worker : MT5_WORKER_SECRET)
//     corps : { name, account, positions }
//     -> { ok: true, count, updatedAt }
//     Si positions est vide, la clé KV est supprimée (plus de position ouverte).

function cleanMt5Positions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list.slice(0, 100)) {
    if (!p || typeof p.ticket !== "number" || !p.symbol) continue;
    out.push({
      ticket: p.ticket,
      position: typeof p.position === "number" ? p.position : p.ticket,
      symbol: String(p.symbol).slice(0, 30),
      type: p.type === "sell" ? "sell" : "buy",
      volume: Math.abs(Number(p.volume) || 0),
      openTime: Number(p.openTime) || 0,
      openPrice: Number(p.openPrice) || 0,
      currentPrice: Number(p.currentPrice) || 0,
      profit: Number(p.profit) || 0,
      commission: Number(p.commission) || 0,
      swap: Number(p.swap) || 0,
      sl: Number(p.sl) || 0,
      tp: Number(p.tp) || 0,
    });
  }
  out.sort((a, b) => b.openTime - a.openTime);
  return out;
}

// GET /mt5/positions — lecture pour le site, avec le token de session.
// `sessionName` est le nom d'utilisateur Peaset déjà vérifié par le site,
// comme dans GET /mt5/deals. `env` et `CHAT_KV` sont les bindings du Worker.
async function handleMt5PositionsGet(env, sessionName) {
  const raw = await env.CHAT_KV.get("mt5positions:" + sessionName, "json");
  const positions = Array.isArray(raw && raw.positions) ? raw.positions : [];
  const account = (raw && raw.account) || null;
  const updatedAt = (raw && raw.updatedAt) || 0;
  return { positions, account, updatedAt };
}

// POST /mt5/positions-worker — écriture par l'EA / le programme Python.
// `body` : { name, account, positions }
// `isWorkerAuth` : vrai si l'en-tête correspond à MT5_WORKER_SECRET.
async function handleMt5PositionsWorker(env, body, isWorkerAuth) {
  if (!isWorkerAuth) return { error: "Non autorisé", status: 401 };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "Nom manquant", status: 400 };
  const positions = cleanMt5Positions(body.positions);
  const key = "mt5positions:" + name;
  if (positions.length === 0) {
    await env.CHAT_KV.delete(key);
    return { ok: true, count: 0, updatedAt: Date.now() };
  }
  const account = body.account && typeof body.account === "object"
    ? { login: body.account.login || null, server: body.account.server || null, balance: body.account.balance || null, equity: body.account.equity || null }
    : null;
  await env.CHAT_KV.put(key, JSON.stringify({ positions, account, updatedAt: Date.now() }));
  return { ok: true, count: positions.length, updatedAt: Date.now() };
}

export { cleanMt5Positions, handleMt5PositionsGet, handleMt5PositionsWorker };
