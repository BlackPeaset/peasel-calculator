// PEASET Calculator — moteur communautaire (Discussion + Avis + Discussions privées)
// Cloudflare Worker + KV (liaison : CHAT_KV)
// GET  /messages  -> liste des messages de discussion (JSON)
// POST /messages  -> { name, text } ajoute un message
// GET  /reviews   -> liste des avis (étoiles + commentaires)
// POST /reviews   -> { name, stars, text } ajoute un avis (stars = 1 à 5)
// GET  /traders   -> liste des noms de traders connus
// GET  /private?me=X&with=Y -> messages privés entre X et Y
// POST /private   -> { from, to, text } ajoute un message privé
// POST /email/register        -> { name, email } enregistre l'email, envoie un code de vérification
// POST /email/verify          -> { name, code } confirme l'email
// POST /email/recover         -> { name } envoie un code de récupération à l'email vérifié
// POST /email/recover-verify  -> { name, code } valide le code de récupération
// POST /account/register       -> { email, password } crée un compte (en attente), envoie un code de vérification
// POST /account/verify         -> { email, code } confirme l'email du compte, ouvre une session (jeton)
// POST /account/login          -> { email, password } connexion, nouveau jeton de session
// POST /account/profile        -> { token, name } lie un nom de trader au compte connecté
// POST /account/recover        -> { email } envoie un code de récupération (réponse toujours ok)
// POST /account/recover-verify -> { email, code, newPassword } nouveau mot de passe + nouveau jeton
// POST /account/password       -> { token, currentPassword, newPassword } change le mot de passe du compte
// POST /messages/react        -> { name, token, id, emoji } ajoute/retire une réaction (👍 ❤️ 🔥)
// POST /messages/delete       -> { name, token, id } efface un message (auteur ou admin)
// POST /messages/pin          -> { name, token, id } épingle un message (admin seulement ; id null = désépingler)
// GET  /pin                   -> message épinglé actuel
// POST /voice                 -> { name, token, data (base64 sans préfixe), type } envoie une note vocale, renvoie { id }
// GET  /voice/:id             -> l'audio binaire de la note vocale
// POST /presence              -> { name, token } signal de présence (battement de cœur)
// GET  /presence              -> traders en ligne (3 dernières minutes)
// POST /donations             -> { name, amount, method, code } déclare un don (public ; montant en gourdes)
// POST /donations/list        -> { token } liste des dons déclarés (admin seulement, du plus récent au plus ancien)
// POST /donations/status      -> { token, id, status } confirme / rejette / remet en attente un don (admin seulement)
// POST /admin/accounts         -> { token } liste des comptes (email, nom, vérifié, bloqué, date) (admin seulement)
// POST /admin/block            -> { token, email, blocked } bloque ou débloque un compte, session révoquée si blocage (admin seulement)
// POST /admin/activity         -> { token } résumé d'activité : comptes, messages, avis, en ligne, dons, derniers messages et avis (admin seulement)
// GET  /donors                -> donateurs ayant au moins un don confirmé de 500 HTG ou plus, en objets { name, amount } (amount = plus gros don confirmé) pour le niveau de badge (public, pour le badge « petit v »)
// Dons : une déclaration n'est PAS une preuve de paiement — le propriétaire vérifie lui-même dans son application MonCash/NatCash.
// Discussion v3 : chaque nouveau message a un id, des réactions, une réponse citée et un avatar optionnels.
// Admin de la discussion : variable ADMIN_NAME du Worker (défaut : Black_peaset) ; son jeton reste exigé.
// Comptes v2 : mot de passe haché PBKDF2-SHA256 (jamais en clair), jetons de session conservés en haché SHA-256.
// Envoi d'email via Brevo : variables du Worker BREVO_API_KEY (secret) et SENDER_EMAIL.

/* Cache mémoire des identifiants TURN éphémères (relais
   Cloudflare Realtime) : générés pour 24 h, renouvelés
   après 12 h — voir la route /rooms/ice. */
let TURN_CACHE = { at: 0, servers: null };
const MESSAGES_KEY = "messages";
const REVIEWS_KEY = "reviews";
const MAX_MESSAGES = 200;
const MAX_REVIEWS = 200;
const MAX_NAME = 40;
const MAX_TEXT = 500;
const MAX_REVIEW_TEXT = 300;
const TRADERS_KEY = "traders";
const MAX_PRIVATE = 200;
// Notes vocales : chaque audio est rangé sous sa propre clé KV ("voice:<id>"),
// le message ne garde que la référence. Pas de limite de 2 minutes demandée par
// le propriétaire : la voix dure aussi longtemps que la personne parle. Restent
// seulement des plafonds techniques larges pour que l'envoi ne casse pas :
// ~20 Mo en base64 (~15 Mo d'audio) et 30 minutes de durée affichée.
const MAX_VOICE_B64 = 20000000;
const MAX_VOICE_DUR = 1800;
function voiceKey(id) { return "voice:" + id; }
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function readList(env, key) {
  const raw = await env.CHAT_KV.get(key);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

async function registerTrader(env, name) {
  if (!name) return;
  const list = await readList(env, TRADERS_KEY);
  if (!list.includes(name)) {
    list.push(name);
    list.sort();
    await env.CHAT_KV.put(TRADERS_KEY, JSON.stringify(list.slice(0, 500)));
  }
}

function pairKey(a, b) {
  const pair = [a, b].sort();
  return "priv:" + pair[0] + "::" + pair[1];
}

async function parseBody(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}


async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function accountKey(name) { return "account:" + name.toLowerCase(); }
function codeKey(name, purpose) { return "code:" + purpose + ":" + name.toLowerCase(); }

async function readAccount(env, name) {
  const raw = await env.CHAT_KV.get(accountKey(name));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function sendEmail(env, to, subject, text) {
  if (!env.BREVO_API_KEY || !env.SENDER_EMAIL) return false;
  // Un échec ou une lenteur de Brevo ne doit JAMAIS planter la route qui
  // appelle sendEmail (vu le 2026-11-22 : fetch Brevo qui jette une
  // exception -> erreur 1101 sur /account/register et /account/recover,
  // et le site affichait « service injoignable » sur tous les téléphones).
  // On borne l'attente à 10 s et on rend false en cas de problème.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try {
      resp = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "api-key": env.BREVO_API_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          sender: { name: "PEASET Calculator", email: env.SENDER_EMAIL },
          to: [{ email: to }],
          subject: subject,
          textContent: text,
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    return resp.ok;
  } catch (e) {
    return false;
  }
}

async function issueCode(env, name, purpose) {
  const now = Date.now();
  const existingRaw = await env.CHAT_KV.get(codeKey(name, purpose));
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      if (existing && existing.sentAt && now - existing.sentAt < CODE_RESEND_MS) {
        return { error: "wait" };
      }
    } catch (e) { /* ignore */ }
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const record = {
    hash: await sha256Hex(code + ":" + name.toLowerCase()),
    exp: now + CODE_TTL_MS,
    sentAt: now,
    tries: 0,
  };
  await env.CHAT_KV.put(codeKey(name, purpose), JSON.stringify(record));
  return { code: code };
}

async function checkCode(env, name, purpose, code) {
  const raw = await env.CHAT_KV.get(codeKey(name, purpose));
  if (!raw) return false;
  let record;
  try { record = JSON.parse(raw); } catch (e) { return false; }
  if (!record || Date.now() > record.exp || record.tries >= 5) {
    await env.CHAT_KV.delete(codeKey(name, purpose));
    return false;
  }
  const hash = await sha256Hex(String(code || "").trim() + ":" + name.toLowerCase());
  if (hash !== record.hash) {
    record.tries += 1;
    await env.CHAT_KV.put(codeKey(name, purpose), JSON.stringify(record));
    return false;
  }
  await env.CHAT_KV.delete(codeKey(name, purpose));
  return true;
}


function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Si le nom appartient à un compte email vérifié, le jeton du propriétaire est exigé.
async function nameAuthorized(env, name, token) {
  const account = await readAccount(env, name);
  if (!account || !account.emailVerified) return true; // nom libre, non enregistré
  if (!token) return false;
  const hash = await sha256Hex(String(token));
  if (account.tokenHash && hash === account.tokenHash) return true;
  // Comptes v2 : le jeton de session du compte dont le nom lié est ce nom autorise aussi.
  const session = await readAccountByTokenHash(env, hash);
  if (session && session.name && session.name.toLowerCase() === String(name).toLowerCase()) return true;
  return false;
}

async function issueToken(env, account) {
  const token = newToken();
  account.tokenHash = await sha256Hex(token);
  account.updatedAt = Date.now();
  await env.CHAT_KV.put(accountKey(account.name), JSON.stringify(account));
  return token;
}

// ---------- Comptes v2 (email + mot de passe, sessions) ----------

function jsonOk(obj) {
  return Response.json(obj, { headers: corsHeaders() });
}

function jsonError(status, message) {
  return Response.json({ error: message }, { status: status, headers: corsHeaders() });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 120);
}

function isValidEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function derivePasswordKey(password, saltBytes, iterations) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: iterations, hash: "SHA-256" },
    material, 256);
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const derived = await derivePasswordKey(password, salt, 100000);
  return {
    algo: "PBKDF2-SHA256",
    iter: 100000,
    salt: bytesToBase64(salt),
    hash: bytesToBase64(derived),
  };
}

async function verifyPassword(password, passRecord) {
  if (!passRecord || !passRecord.salt || !passRecord.hash) return false;
  try {
    const derived = await derivePasswordKey(password, base64ToBytes(passRecord.salt), passRecord.iter || 100000);
    const expected = base64ToBytes(passRecord.hash);
    if (derived.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < derived.length; i++) diff |= derived[i] ^ expected[i];
    return diff === 0;
  } catch (e) {
    return false;
  }
}

function emailAccountKey(email) { return "account:" + email; }

// Lit un compte v2 (clé = email). Les anciennes fiches de protection de nom
// partagent le préfixe "account:" : on ne reconnaît que les fiches qui ont la
// forme d'un compte v2 (mot de passe + champ verified), pour ne jamais les confondre.
async function readEmailAccount(env, email) {
  const raw = await env.CHAT_KV.get(emailAccountKey(email));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    if (rec && rec.pass && typeof rec.verified === "boolean") return rec;
    return null;
  } catch (e) {
    return null;
  }
}

async function writeEmailAccount(env, account) {
  await env.CHAT_KV.put(emailAccountKey(account.email), JSON.stringify(account));
}

// Recopie le jeton courant du compte dans la fiche de protection de son nom lié,
// pour que la publication (discussion, avis, privé) continue de marcher avec ce jeton.
async function syncNameRecord(env, account) {
  if (!account.name) return;
  const existing = await readAccount(env, account.name);
  if (existing && existing.pass) return; // la clé appartient à un compte v2, pas à une fiche nom
  const rec = existing && typeof existing === "object" ? existing : {};
  rec.name = account.name;
  rec.email = account.email;
  rec.emailVerified = true;
  rec.tokenHash = account.tokenHash;
  rec.updatedAt = Date.now();
  await env.CHAT_KV.put(accountKey(account.name), JSON.stringify(rec));
}

// Émet un nouveau jeton de session pour un compte v2 (rotation : l'ancien jeton
// est invalidé). Seul le haché SHA-256 du jeton est conservé, jamais le jeton en clair.
async function issueAccountToken(env, account) {
  const token = newToken();
  const hash = await sha256Hex(token);
  const oldHash = account.tokenHash;
  account.tokenHash = hash;
  /* Les 4 ecritures touchent des cles differentes : en parallele
     au lieu d'une apres l'autre, la connexion repond plus vite. */
  const jobs = [
    env.CHAT_KV.put("token:" + hash, account.email),
    writeEmailAccount(env, account),
    syncNameRecord(env, account),
  ];
  if (oldHash) jobs.push(env.CHAT_KV.delete("token:" + oldHash));
  await Promise.all(jobs);
  return token;
}

async function readAccountByTokenHash(env, tokenHash) {
  if (!tokenHash) return null;
  const email = await env.CHAT_KV.get("token:" + tokenHash);
  if (!email) return null;
  const account = await readEmailAccount(env, email);
  if (!account || account.tokenHash !== tokenHash) return null;
  return account;
}

async function readAccountByToken(env, token) {
  if (!token) return null;
  return readAccountByTokenHash(env, await sha256Hex(String(token)));
}

// ---------- Discussion v3 : réactions, épinglé, présence ----------

const PIN_KEY = "pin";
const REPORTS_KEY = "reports";
const PRESENCE_INDEX_KEY = "presence:index";
const PRESENCE_WINDOW_MS = 180 * 1000;
const REACTION_EMOJIS = ["👍", "❤️", "🔥"];

function newMessageId() {
  const rand = new Uint8Array(4);
  crypto.getRandomValues(rand);
  return Date.now().toString(36) + Array.from(rand).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Admin : variable ADMIN_NAME si elle est définie, sinon Black_peaset.
// Être nommé admin ne suffit pas : le jeton du compte/nom doit aussi passer.
function adminName(env) {
  return String((env && env.ADMIN_NAME) || "Black_peaset").trim();
}

function isAdminName(env, name) {
  return String(name || "").trim().toLowerCase() === adminName(env).toLowerCase();
}

async function readPin(env) {
  const raw = await env.CHAT_KV.get(PIN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// ---------- Dons déclarés (contrôle des dons) ----------

const DONATIONS_KEY = "donations";
const MAX_DONATIONS = 500;
// Badge bleu « petit v » : il faut un don confirmé d'au moins ce montant (en gourdes).
const BADGE_MIN_HTG = 500;
const DONATION_STATUSES = ["attente", "confirme", "rejete"];

// Accès admin aux dons : (a) jeton de session d'un compte v2 dont le nom lié est
// l'admin, ou (b) jeton de protection du nom admin. Contrairement à
// nameAuthorized, un nom libre (non vérifié) ne donne ici AUCUN accès : la fiche
// du nom doit exister, être vérifiée et porter le même haché de jeton.
async function isAdminRequest(env, token) {
  if (!token) return false;
  const account = await readAccountByToken(env, token);
  if (account && account.name && isAdminName(env, account.name)) return true;
  const hash = await sha256Hex(String(token));
  const rec = await readAccount(env, adminName(env));
  if (rec && !rec.pass && rec.emailVerified && rec.tokenHash && rec.tokenHash === hash) return true;
  return false;
}

// ---------- Panneau de contrôle admin : comptes, blocage, activité ----------

// Liste les comptes v2 (clé "account:<email>") en interne. Les anciennes fiches
// de protection de nom partagent le préfixe "account:" : on ne garde que les
// fiches en forme de compte v2 (mot de passe + champ verified).
async function listEmailAccounts(env) {
  const out = [];
  let cursor = undefined;
  for (let page = 0; page < 5; page++) {
    const res = await env.CHAT_KV.list({ prefix: "account:", cursor: cursor, limit: 200 });
    for (const k of res.keys || []) {
      const raw = await env.CHAT_KV.get(k.name);
      if (!raw) continue;
      let rec = null;
      try { rec = JSON.parse(raw); } catch (e) { rec = null; }
      if (!rec || !rec.pass || typeof rec.verified !== "boolean" || !rec.email) continue;
      out.push(rec);
    }
    if (!res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}

// Vue publique d'un compte pour le panneau de contrôle : jamais le mot de
// passe ni le jeton de session.
function publicAccount(rec) {
  return {
    email: rec.email,
    name: rec.name || null,
    verified: !!rec.verified,
    blocked: !!rec.blocked,
    createdAt: rec.createdAt || null,
  };
}

// Référence d'une note vocale déjà envoyée (POST /voice) à accrocher à un
// message : renvoie { id, dur, peaks? } ou null si l'audio n'existe pas.
// "peaks" = la forme d'onde (48 hauteurs max, 0..1) calculée par le téléphone
// de l'expéditeur, pour afficher la vague façon WhatsApp sans télécharger l'audio.
async function attachVoice(env, body) {
  const voiceId = String(body.voiceId || "");
  if (!voiceId || !/^[a-z0-9]+$/.test(voiceId)) return null;
  const raw = await env.CHAT_KV.get(voiceKey(voiceId));
  if (!raw) return null;
  const out = { id: voiceId, dur: Math.max(0, Math.min(MAX_VOICE_DUR, Math.round(Number(body.voiceDur) || 0))) };
  if (Array.isArray(body.voicePeaks) && body.voicePeaks.length) {
    out.peaks = body.voicePeaks.slice(0, 48).map(v => {
      const n = Number(v);
      return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    });
  }
  return out;
}

// Un compte bloqué par l'admin ne peut plus publier : on le reconnaît par son
// jeton de session ou par la fiche du nom qu'il utilise.
async function posterBlocked(env, name, token) {
  if (token) {
    const acc = await readAccountByToken(env, token);
    if (acc && acc.blocked) return true;
  }
  if (name) {
    const rec = await readAccount(env, name);
    if (rec && rec.email) {
      const acc = await readEmailAccount(env, String(rec.email).toLowerCase());
      if (acc && acc.blocked) return true;
    }
  }
  return false;
}

// ---------- Stockage D1 (remplace KV : 100 000 écritures/jour au lieu de 1 000) ----------
// Table kv(key TEXT PRIMARY KEY, value TEXT, expires INTEGER /* epoch secondes, NULL = jamais */).
// Interface volontairement identique à KV : get (texte ou "json"), put (+ expirationTtl), delete, list.
let peasetD1Ready = null;
async function d1Retry(fn) {
  let lastErr = null;
  const delays = [80, 250, 600, 1200];
  for (let i = 0; i < 5; i++) {
    try { return await fn(); } catch (e) { lastErr = e; if (i < 4) await new Promise((r) => setTimeout(r, delays[i])); }
  }
  throw lastErr;
}

function makeD1Store(db) {
  if (!peasetD1Ready) {
    peasetD1Ready = db.prepare("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, expires INTEGER)").run().then(() => true).catch(() => { peasetD1Ready = null; return false; });
  }
  const nowS = () => Math.floor(Date.now() / 1000);
  return {
    async get(key, type) {
      await peasetD1Ready;
      const row = await d1Retry(() => db.prepare("SELECT value, expires FROM kv WHERE key = ?1").bind(key).first());
      if (!row) return null;
      if (row.expires !== null && row.expires <= nowS()) return null;
      if (type === "json" || (type && type.type === "json")) {
        try { return JSON.parse(row.value); } catch (e) { return null; }
      }
      return row.value;
    },
    async put(key, value, options) {
      await peasetD1Ready;
      let exp = null;
      if (options && options.expirationTtl) exp = nowS() + Number(options.expirationTtl);
      else if (options && options.expiration) exp = Number(options.expiration);
      await d1Retry(() => db.prepare("INSERT INTO kv (key, value, expires) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires").bind(key, String(value), exp).run());
    },
    async delete(key) {
      await peasetD1Ready;
      await d1Retry(() => db.prepare("DELETE FROM kv WHERE key = ?1").bind(key).run());
    },
    async list(options) {
      await peasetD1Ready;
      const prefix = (options && options.prefix) || "";
      const limit = Math.min((options && options.limit) || 1000, 1000);
      const offset = options && options.cursor ? (parseInt(options.cursor, 10) || 0) : 0;
      const esc = prefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const res = await d1Retry(() => db.prepare("SELECT key FROM kv WHERE key LIKE ?1 ESCAPE '\\' AND (expires IS NULL OR expires > ?2) ORDER BY key LIMIT ?3 OFFSET ?4").bind(esc + "%", nowS(), limit + 1, offset).all());
      const names = (res.results || []).map((r) => r.key);
      const complete = names.length <= limit;
      const page = complete ? names : names.slice(0, limit);
      return { keys: page.map((name) => ({ name: name })), list_complete: complete, cursor: complete ? "" : String(offset + limit) };
    }
  };
}

// ---------- Base de connaissances de l'assistante : les réponses du site (FR + HT), choisies par sujet ----------
// ---------- Base de connaissances de l'assistante : chargée à la demande depuis D1 ----------
// L'index faisait ~194 Ko en ligne directe dans le script : chaque démarrage à froid
// du moteur devait l'analyser, et 1 requête sur ~5-10 mourait avec l'erreur 1101
// (connexion / inscription injoignables). Il vit maintenant en D1, en 4 morceaux,
// et n'est lu que pour /assistant, une fois par démarrage.
let assistantKbCache = null;
let assistantKbPromise = null;
async function getAssistantKb(env) {
  if (assistantKbCache) return assistantKbCache;
  if (!assistantKbPromise) assistantKbPromise = (async () => {
    try {
      let raw = "";
      for (let i = 0; i < 4; i++) {
        const part = await env.CHAT_KV.get("kb:assistant:" + i);
        if (!part) break;
        raw += part;
      }
      if (!raw) {
        const one = await env.CHAT_KV.get("kb:assistant");
        if (one) raw = one;
      }
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr) && arr.length) { assistantKbCache = arr; return arr; }
    } catch (e) { /* l'assistante répond sans les sujets */ }
    return [];
  })();
  return assistantKbPromise;
}

// ---------- MT5 maison : chiffrement du mot de passe investisseur ----------
// AES-GCM (clé 256 bits, IV aléatoire 12 octets). La clé vit dans le
// secret Worker MT5_LINK_KEY (base64) et ne sort jamais d'ici.
let MT5_LINK_KEY_CACHE = null;
async function getMt5LinkKey(env) {
  if (MT5_LINK_KEY_CACHE) return MT5_LINK_KEY_CACHE;
  const b64 = String(env.MT5_LINK_KEY || "");
  if (!b64) return null;
  let raw;
  try { raw = base64ToBytes(b64); } catch (e) { return null; }
  if (raw.length !== 32) return null;
  try {
    MT5_LINK_KEY_CACHE = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch (e) { return null; }
  return MT5_LINK_KEY_CACHE;
}
async function mt5EncryptPassword(env, password) {
  const key = await getMt5LinkKey(env);
  if (!key) return null;
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(password));
  return { enc: bytesToBase64(new Uint8Array(ct)), iv: bytesToBase64(iv) };
}
async function mt5DecryptPassword(env, enc, iv) {
  const key = await getMt5LinkKey(env);
  if (!key) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, key, base64ToBytes(enc));
    return new TextDecoder().decode(pt);
  } catch (e) { return null; }
}
function timingSafeEqual(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
function workerAuthed(env, request, body) {
  const secret = String(env.MT5_WORKER_SECRET || "");
  if (!secret) return false;
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ") && timingSafeEqual(auth.slice(7), secret)) return true;
  if (body && timingSafeEqual(String(body.worker_secret || ""), secret)) return true;
  return false;
}

export default {
  async fetch(request, env) {
    // Filet de sécurité (v85) : toute erreur inattendue (base
    // momentanément injoignable, démarrage à froid…) devient une
    // erreur JSON 503 que le site réessaie toute seule, au lieu
    // d'une page d'erreur 500 qui bloque la connexion.
    try {
    if (env.DB) env = Object.assign({}, env, { CHAT_KV: makeD1Store(env.DB) });
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);

    // ---------- Notes vocales : envoi (l'audio part en base64, sans préfixe) ----------
    if (url.pathname === "/voice" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      if (!name) return jsonError(400, "Nom manquant");
      if (!(await nameAuthorized(env, name, body.token))) {
        return jsonError(403, "Nom protégé : vérification email requise");
      }
      if (await posterBlocked(env, name, body.token)) {
        return jsonError(403, "Compte bloqué par l'administrateur");
      }
      const data = String(body.data || "");
      const type = String(body.type || "");
      if (!data || data.length > MAX_VOICE_B64 || !/^audio\//.test(type)) {
        return jsonError(400, "Audio invalide ou trop lourd (environ 30 minutes maximum)");
      }
      const id = newMessageId();
      await env.CHAT_KV.put(voiceKey(id), JSON.stringify({ data: data, type: type, by: name, t: Date.now() }));
      return jsonOk({ ok: true, id: id });
    }

    // ---------- Notes vocales : lecture (audio binaire) ----------
    if (url.pathname.startsWith("/voice/") && request.method === "GET") {
      const id = url.pathname.slice("/voice/".length);
      if (!/^[a-z0-9]+$/.test(id)) return jsonError(404, "Audio introuvable");
      const raw = await env.CHAT_KV.get(voiceKey(id));
      if (!raw) return jsonError(404, "Audio introuvable");
      let rec = null;
      try { rec = JSON.parse(raw); } catch (e) { rec = null; }
      if (!rec || !rec.data) return jsonError(404, "Audio introuvable");
      const headers = corsHeaders();
      headers["Content-Type"] = rec.type || "audio/webm";
      headers["Cache-Control"] = "public, max-age=86400";
      return new Response(base64ToBytes(rec.data), { headers: headers });
    }

    // ---------- Photos de profil : envoi (image en base64, sans préfixe) ----------
    if (url.pathname === "/photo" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const acc = await readAccountByToken(env, body.token);
      if (!acc) return jsonError(401, "Connexion requise");
      if (acc.blocked) return jsonError(403, "Compte bloqué par l'administrateur");
      const data = String(body.data || "");
      const type = String(body.type || "");
      if (!data || data.length > 4000000 || ["image/jpeg", "image/png", "image/webp"].indexOf(type) < 0) {
        return jsonError(400, "Photo invalide ou trop lourde (environ 3 Mo maximum)");
      }
      const id = newMessageId();
      await env.CHAT_KV.put("photo:" + id, JSON.stringify({ data: data, type: type, by: acc.name, t: Date.now() }));
      await env.CHAT_KV.put("photoBy:" + acc.name.toLowerCase(), id);
      return jsonOk({ ok: true, id: id });
    }

    // ---------- Photos de profil : lecture (image binaire) ----------
    if (url.pathname.startsWith("/photo/") && request.method === "GET") {
      const id = url.pathname.slice("/photo/".length);
      if (!/^[a-z0-9]+$/.test(id)) return jsonError(404, "Photo introuvable");
      const raw = await env.CHAT_KV.get("photo:" + id);
      if (!raw) return jsonError(404, "Photo introuvable");
      let rec = null;
      try { rec = JSON.parse(raw); } catch (e) { rec = null; }
      if (!rec || !rec.data) return jsonError(404, "Photo introuvable");
      const headers = corsHeaders();
      headers["Content-Type"] = rec.type || "image/jpeg";
      headers["Cache-Control"] = "public, max-age=86400";
      return new Response(base64ToBytes(rec.data), { headers: headers });
    }

    // Fusion des trades fermés (programme maison : une seule logique).
    function cleanMt5Deals(deals) {
      const clean = [];
      for (const d of deals) {
        if (!d || typeof d !== "object") continue;
        const ticket = Number(d.ticket);
        if (!ticket || !isFinite(ticket)) continue;
        const symbol = String(d.symbol || "").slice(0, 30);
        if (!symbol) continue;
        clean.push({
          ticket: ticket,
          position: Number(d.position) || ticket,
          symbol: symbol,
          type: d.type === "sell" ? "sell" : "buy",
          volume: Math.abs(Number(d.volume) || 0),
          openTime: Number(d.openTime) || 0,
          closeTime: Number(d.closeTime) || 0,
          openPrice: Number(d.openPrice) || 0,
          closePrice: Number(d.closePrice) || 0,
          profit: Number(d.profit) || 0,
          commission: Number(d.commission) || 0,
          swap: Number(d.swap) || 0
        });
      }
      return clean;
    }
    async function mergeMt5Deals(env, nameLower, clean) {
      let existing = [];
      try { existing = JSON.parse(await env.CHAT_KV.get("mt5deals:" + nameLower) || "[]"); } catch (e) { existing = []; }
      if (!Array.isArray(existing)) existing = [];
      const seen = new Set(existing.map(x => x.ticket));
      let added = 0;
      for (const d of clean) {
        if (!seen.has(d.ticket)) { existing.push(d); seen.add(d.ticket); added++; }
      }
      existing.sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0));
      const kept = existing.slice(0, 300);
      await env.CHAT_KV.put("mt5deals:" + nameLower, JSON.stringify(kept));
      return { added: added, total: kept.length };
    }

    // Positions ouvertes (système maison, sans MetaAPI) : nettoyage
    // d'une liste de positions en cours, même forme que les deals
    // fermés, mais avec prix actuel, S/L et T/P. Remplacement complet
    // (une position ouverte est un état, pas un historique).
    function cleanMt5Positions(positions) {
      const clean = [];
      for (const p of positions) {
        if (!p || typeof p !== "object") continue;
        const ticket = Number(p.ticket);
        if (!ticket || !isFinite(ticket)) continue;
        const symbol = String(p.symbol || "").slice(0, 30);
        if (!symbol) continue;
        clean.push({
          ticket: ticket,
          position: Number(p.position) || ticket,
          symbol: symbol,
          type: p.type === "sell" ? "sell" : "buy",
          volume: Math.abs(Number(p.volume) || 0),
          openTime: Number(p.openTime) || 0,
          openPrice: Number(p.openPrice) || 0,
          currentPrice: Number(p.currentPrice) || 0,
          profit: Number(p.profit) || 0,
          commission: Number(p.commission) || 0,
          swap: Number(p.swap) || 0,
          sl: Number(p.sl) || 0,
          tp: Number(p.tp) || 0
        });
      }
      clean.sort((a, b) => (b.openTime || 0) - (a.openTime || 0));
      return clean;
    }

    // ---------- MT5 : système maison uniquement ----------
    // Connexion par mot de passe investisseur (lecture seule), chiffré
    // et stocké ici ; le programme maison lit l'historique et l'envoie
    // via /mt5/sync-worker. Aucun service externe, aucun robot, aucune clé.

    if (url.pathname === "/mt5/deals" && request.method === "GET") {
      const acc = await readAccountByToken(env, url.searchParams.get("token") || "");
      if (!acc) return jsonError(401, "Connexion requise");
      const nameLower = String(acc.name).toLowerCase();
      let deals = [];
      try { deals = JSON.parse(await env.CHAT_KV.get("mt5deals:" + nameLower) || "[]"); } catch (e) { deals = []; }
      if (!Array.isArray(deals)) deals = [];
      let account = null;
      try { account = JSON.parse(await env.CHAT_KV.get("mt5account:" + nameLower) || "null"); } catch (e) { account = null; }
      return jsonOk({ ok: true, deals: deals, account: account });
    }

    // ---------- MT5 : positions ouvertes (système maison, sans MetaAPI) ----------
    // Lecture pour le site, avec le jeton de session, comme /mt5/deals.
    // Clé : mt5positions:<nom> -> {positions, updatedAt}.
    if (url.pathname === "/mt5/positions" && request.method === "GET") {
      const acc = await readAccountByToken(env, url.searchParams.get("token") || "");
      if (!acc) return jsonError(401, "Connexion requise");
      const nameLower = String(acc.name).toLowerCase();
      let positions = [];
      let updatedAt = null;
      try {
        const raw = JSON.parse(await env.CHAT_KV.get("mt5positions:" + nameLower) || "null");
        if (raw && Array.isArray(raw.positions)) { positions = raw.positions; updatedAt = Number(raw.updatedAt) || null; }
        else if (Array.isArray(raw)) { positions = raw; }
      } catch (e) { positions = []; }
      let account = null;
      try { account = JSON.parse(await env.CHAT_KV.get("mt5account:" + nameLower) || "null"); } catch (e) { account = null; }
      return jsonOk({ ok: true, positions: positions, account: account, updatedAt: updatedAt });
    }

    // ---------- MT5 maison : lien par mot de passe investisseur ----------
    // Le mot de passe investisseur est CHIFFRÉ (AES-GCM, secret
    // MT5_LINK_KEY) et stocké dans mt5link:<nom>. Il n'est JAMAIS
    // renvoyé au site : seul le programme de synchro (secret Worker
    // MT5_WORKER_SECRET) peut le relire via /mt5/link-get.
    // Clés : mt5link:<nom> -> {login, server, enc, iv, t} ;
    //        mt5syncnow:<nom> -> {t} (demande « Sync now ») ;
    //        mt5syncstate:<nom> -> {t} (dernière synchro réussie).
    if (url.pathname === "/mt5/link" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const acc = await readAccountByToken(env, body.token);
      if (!acc) return jsonError(401, "Connexion requise");
      if (acc.blocked) return jsonError(403, "Compte bloqué par l'administrateur");
      const login = String(body.login || "").trim();
      const server = String(body.server || "").trim().slice(0, 120);
      const password = String(body.password || "");
      if (!/^[0-9]{3,20}$/.test(login) || !server || password.length < 6) return jsonError(400, "Numéro de compte, serveur ou mot de passe manquant");
      if (!env.MT5_LINK_KEY) return jsonError(503, "Liaison MT5 pas encore activée");
      let enc = null;
      try { enc = await mt5EncryptPassword(env, password); } catch (e) { enc = null; }
      if (!enc) return jsonError(503, "Liaison MT5 pas encore activée");
      const nameLower = String(acc.name).toLowerCase();
      await env.CHAT_KV.put("mt5link:" + nameLower, JSON.stringify({ login: login, server: server, enc: enc.enc, iv: enc.iv, t: Date.now() }));
      return jsonOk({ ok: true });
    }

    if (url.pathname === "/mt5/unlink" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const acc = await readAccountByToken(env, body.token);
      if (!acc) return jsonError(401, "Connexion requise");
      const nameLower = String(acc.name).toLowerCase();
      await env.CHAT_KV.delete("mt5link:" + nameLower);
      await env.CHAT_KV.delete("mt5syncnow:" + nameLower);
      return jsonOk({ ok: true });
    }

    if (url.pathname === "/mt5/links" && request.method === "GET") {
      if (!workerAuthed(env, request, null)) return jsonError(401, "Non autorisé");
      let keys = [];
      try { const listed = await env.CHAT_KV.list({ prefix: "mt5link:" }); keys = (listed.keys || []).map(k => k.name); } catch (e) { keys = []; }
      const links = [];
      for (const key of keys) {
        const nameLower = key.slice("mt5link:".length);
        let rec = null;
        try { rec = JSON.parse(await env.CHAT_KV.get(key) || "null"); } catch (e) { rec = null; }
        if (!rec || !rec.login || !rec.server) continue;
        let lastSync = null;
        try { const st = JSON.parse(await env.CHAT_KV.get("mt5syncstate:" + nameLower) || "null"); if (st && st.t) lastSync = Number(st.t); } catch (e) {}
        links.push({ name: nameLower, login: rec.login, server: rec.server, t: Number(rec.t) || 0, lastSync: lastSync });
      }
      return jsonOk({ ok: true, links: links });
    }

    if (url.pathname === "/mt5/link-get" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      if (!workerAuthed(env, request, body)) return jsonError(401, "Non autorisé");
      const nameLower = String(body.name || "").trim().toLowerCase();
      if (!nameLower) return jsonError(400, "Nom manquant");
      let rec = null;
      try { rec = JSON.parse(await env.CHAT_KV.get("mt5link:" + nameLower) || "null"); } catch (e) { rec = null; }
      if (!rec || !rec.enc || !rec.iv) return jsonError(404, "Aucun compte MT5 lié");
      const password = await mt5DecryptPassword(env, rec.enc, rec.iv);
      if (password === null) return jsonError(503, "Liaison MT5 pas encore activée");
      return jsonOk({ ok: true, login: rec.login, server: rec.server, password: password });
    }

    if (url.pathname === "/mt5/sync-worker" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      if (!workerAuthed(env, request, body)) return jsonError(401, "Non autorisé");
      const nameLower = String(body.name || "").trim().toLowerCase();
      if (!nameLower) return jsonError(400, "Nom manquant");
      const linkRaw = await env.CHAT_KV.get("mt5link:" + nameLower);
      if (!linkRaw) return jsonError(404, "Aucun compte MT5 lié");
      if (body.masterPassword === true) {
        await env.CHAT_KV.delete("mt5link:" + nameLower);
        await env.CHAT_KV.delete("mt5syncnow:" + nameLower);
        return jsonOk({ ok: true, deleted: "master" });
      }
      const now = Date.now();
      const clean = cleanMt5Deals(Array.isArray(body.deals) ? body.deals.slice(0, 200) : []);
      const merged = await mergeMt5Deals(env, nameLower, clean);
      if (body.account || body.server) {
        await env.CHAT_KV.put("mt5account:" + nameLower, JSON.stringify({ account: Number(body.account) || 0, server: String(body.server || "").slice(0, 60), balance: Number(body.balance) || 0, equity: Number(body.equity) || 0, t: now }));
      }
      await env.CHAT_KV.put("mt5syncstate:" + nameLower, JSON.stringify({ t: now }));
      await env.CHAT_KV.delete("mt5syncnow:" + nameLower);
      return jsonOk({ ok: true, added: merged.added, total: merged.total });
    }

    // ---------- MT5 : positions ouvertes, envoi par le programme maison ----------
    // Auth Worker (MT5_WORKER_SECRET), comme /mt5/sync-worker : le
    // programme (EA ou Python) envoie les positions ouvertes actuelles.
    // Remplacement complet : une position fermée disparaît de la liste.
    // Liste vide = plus aucune position ouverte, la clé est supprimée.
    if (url.pathname === "/mt5/positions-worker" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      if (!workerAuthed(env, request, body)) return jsonError(401, "Non autorisé");
      const nameLower = String(body.name || "").trim().toLowerCase();
      if (!nameLower) return jsonError(400, "Nom manquant");
      const linkRaw = await env.CHAT_KV.get("mt5link:" + nameLower);
      if (!linkRaw) return jsonError(404, "Aucun compte MT5 lié");
      const now = Date.now();
      const clean = cleanMt5Positions(Array.isArray(body.positions) ? body.positions.slice(0, 100) : []);
      if (!clean.length) {
        await env.CHAT_KV.delete("mt5positions:" + nameLower);
        return jsonOk({ ok: true, count: 0, updatedAt: now });
      }
      await env.CHAT_KV.put("mt5positions:" + nameLower, JSON.stringify({ positions: clean, updatedAt: now }));
      if (body.account || body.server) {
        await env.CHAT_KV.put("mt5account:" + nameLower, JSON.stringify({ account: Number(body.account) || 0, server: String(body.server || "").slice(0, 60), balance: Number(body.balance) || 0, equity: Number(body.equity) || 0, t: now }));
      }
      return jsonOk({ ok: true, count: clean.length, updatedAt: now });
    }

    if (url.pathname === "/mt5/sync-now" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const acc = await readAccountByToken(env, body.token);
      if (!acc) return jsonError(401, "Connexion requise");
      const nameLower = String(acc.name).toLowerCase();
      const linkRaw = await env.CHAT_KV.get("mt5link:" + nameLower);
      if (!linkRaw) return jsonError(404, "Aucun compte MT5 lié");
      await env.CHAT_KV.put("mt5syncnow:" + nameLower, JSON.stringify({ t: Date.now() }));
      return jsonOk({ ok: true });
    }

    if (url.pathname === "/mt5/sync-status" && request.method === "GET") {
      const acc = await readAccountByToken(env, url.searchParams.get("token") || "");
      if (!acc) return jsonError(401, "Connexion requise");
      const nameLower = String(acc.name).toLowerCase();
      const linkRaw = await env.CHAT_KV.get("mt5link:" + nameLower);
      let lastSync = null;
      try { const st = JSON.parse(await env.CHAT_KV.get("mt5syncstate:" + nameLower) || "null"); if (st && st.t) lastSync = Number(st.t); } catch (e) {}
      let pendingSyncNow = false;
      try { const flag = JSON.parse(await env.CHAT_KV.get("mt5syncnow:" + nameLower) || "null"); if (flag && flag.t) pendingSyncNow = !lastSync || Number(flag.t) > lastSync; } catch (e) {}
      return jsonOk({ ok: true, linked: !!linkRaw, lastSync: lastSync, pendingSyncNow: pendingSyncNow });
    }

    // Toute autre route /mt5/* n'existe plus (service externe et robot retirés).
    if (url.pathname.startsWith("/mt5/")) return jsonError(404, "Route MT5 inconnue");

    // ---------- Discussion ----------
    if (url.pathname === "/messages" && request.method === "GET") {
      const list = await readList(env, MESSAGES_KEY);
      // Suivi de lecture (coches bleues) : l'appelant peut s'identifier
      // (?me=<nom>&token=<session>) ; sa lecture est alors enregistrée et
      // chaque message reçoit read/seen=true quand tous les autres lecteurs
      // connus l'ont lu. Sans identification, aucun suivi (comportement d'avant).
      let marks = {};
      try { marks = (await env.CHAT_KV.get("readpub:marks", "json")) || {}; } catch (e) { marks = {}; }
      if (!marks || typeof marks !== "object" || Array.isArray(marks)) marks = {};
      const me = String(url.searchParams.get("me") || "").trim().slice(0, MAX_NAME);
      if (me && (await nameAuthorized(env, me, url.searchParams.get("token") || ""))) {
        const now = Date.now();
        const key = me.toLowerCase();
        if (!marks[key] || now - marks[key] > 30000) {
          marks[key] = now;
          // Purge des lecteurs inactifs depuis plus de 30 jours.
          for (const k of Object.keys(marks)) {
            if (!marks[k] || now - marks[k] > 30 * 24 * 3600 * 1000) delete marks[k];
          }
          await env.CHAT_KV.put("readpub:marks", JSON.stringify(marks));
        }
      }
      const readers = Object.keys(marks);
      if (readers.length) {
        for (const m of list) {
          if (!m || !m.t) continue;
          const author = String(m.name || "").toLowerCase();
          const others = readers.filter(r => r !== author);
          if (others.length && others.every(r => (marks[r] || 0) >= m.t)) {
            m.read = true;
            m.seen = true;
          }
        }
      }
      return Response.json(list, { headers: corsHeaders() });
    }

    if (url.pathname === "/messages" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return new Response("JSON invalide", { status: 400, headers: corsHeaders() });
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      const text = String(body.text || "").trim().slice(0, MAX_TEXT);
      if (!name || (!text && !String(body.voiceId || ""))) {
        return new Response("Nom ou message manquant", { status: 400, headers: corsHeaders() });
      }
      await registerTrader(env, name);
      if (!(await nameAuthorized(env, name, body.token))) {
        return new Response("Nom protégé : vérification email requise", { status: 403, headers: corsHeaders() });
      }
      if (await posterBlocked(env, name, body.token)) {
        return new Response("Compte bloqué par l'administrateur", { status: 403, headers: corsHeaders() });
      }
      // Garde-fous professionnels (l'admin en est exempté) : filtre de liens
      // anti-arnaque et mode lent de 5 secondes. (La porte des règles a été
      // retirée le 2026-11-21 à la demande de l'utilisateur.)
      let slowKey = null;
      if (!isAdminName(env, name)) {
        if (text && /(https?:\/\/|www\.)/i.test(text)) {
          return new Response("Les liens ne sont pas autorisés dans la Discussion (protection anti-arnaque). Seul l'admin peut partager un lien.", { status: 400, headers: corsHeaders() });
        }
        slowKey = "slow:pub:" + name.toLowerCase();
        const lastTs = parseInt((await env.CHAT_KV.get(slowKey)) || "0", 10) || 0;
        const waitMs = lastTs + 5000 - Date.now();
        if (waitMs > 0) {
          return new Response("Mode lent : attends encore " + Math.ceil(waitMs / 1000) + " secondes avant d'écrire.", { status: 429, headers: corsHeaders() });
        }
      }
      const list = await readList(env, MESSAGES_KEY);
      const msg = { id: newMessageId(), name: name, text: text, t: Date.now(), reactions: {} };
      const avatar = String(body.avatar || "").trim();
      if (avatar && avatar.length <= 30) msg.avatar = avatar;
      const voice = await attachVoice(env, body);
      if (voice) msg.voice = voice;
      if (!text && !voice) {
        return new Response("Nom ou message manquant", { status: 400, headers: corsHeaders() });
      }
      if (body.replyTo) {
        const target = list.find(m => m && m.id && m.id === String(body.replyTo));
        if (target) {
          msg.reply = { id: target.id, name: target.name, text: String(target.text || "").slice(0, 80) };
        }
      }
      list.push(msg);
      while (list.length > MAX_MESSAGES) list.shift();
      if (slowKey) await env.CHAT_KV.put(slowKey, String(Date.now()));
      await env.CHAT_KV.put(MESSAGES_KEY, JSON.stringify(list));
      return Response.json({ ok: true }, { headers: corsHeaders() });
    }

    // ---------- Discussion v3 : réactions ----------
    if (url.pathname === "/messages/react" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      if (!name) return jsonError(400, "Nom manquant");
      const emoji = String(body.emoji || "");
      if (!REACTION_EMOJIS.includes(emoji)) return jsonError(400, "Réaction invalide");
      if (!(await nameAuthorized(env, name, body.token))) {
        return jsonError(403, "Nom protégé : vérification email requise");
      }
      if (await posterBlocked(env, name, body.token)) {
        return jsonError(403, "Compte bloqué par l'administrateur");
      }
      const list = await readList(env, MESSAGES_KEY);
      const msg = list.find(m => m && m.id && m.id === String(body.id || ""));
      if (!msg) return jsonError(404, "Message introuvable");
      if (!msg.reactions || typeof msg.reactions !== "object") msg.reactions = {};
      const arr = Array.isArray(msg.reactions[emoji]) ? msg.reactions[emoji].slice() : [];
      const idx = arr.findIndex(n => String(n).toLowerCase() === name.toLowerCase());
      if (idx >= 0) arr.splice(idx, 1); else arr.push(name);
      if (arr.length > 0) msg.reactions[emoji] = arr; else delete msg.reactions[emoji];
      await env.CHAT_KV.put(MESSAGES_KEY, JSON.stringify(list));
      return jsonOk({ ok: true, reactions: msg.reactions });
    }

    // ---------- Discussion v3 : effacer un message ----------
    if (url.pathname === "/messages/delete" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      if (!name) return jsonError(400, "Nom manquant");
      if (!(await nameAuthorized(env, name, body.token))) {
        return jsonError(403, "Nom protégé : vérification email requise");
      }
      if (await posterBlocked(env, name, body.token)) {
        return jsonError(403, "Compte bloqué par l'administrateur");
      }
      const list = await readList(env, MESSAGES_KEY);
      const idx = list.findIndex(m => m && m.id && m.id === String(body.id || ""));
      if (idx < 0) return jsonError(404, "Message introuvable");
      const msg = list[idx];
      const isAuthor = String(msg.name || "").toLowerCase() === name.toLowerCase();
      if (!isAuthor && !isAdminName(env, name)) {
        return jsonError(403, "Tu ne peux pas effacer ce message");
      }
      list.splice(idx, 1);
      await env.CHAT_KV.put(MESSAGES_KEY, JSON.stringify(list));
      const pin = await readPin(env);
      if (pin && pin.id === msg.id) {
        await env.CHAT_KV.delete(PIN_KEY);
      }
      return jsonOk({ ok: true });
    }

    // ---------- Discussion : signaler un message ----------
    if (url.pathname === "/messages/report" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      if (!name) return jsonError(400, "Nom manquant");
      if (!(await nameAuthorized(env, name, body.token))) {
        return jsonError(403, "Nom protégé : vérification email requise");
      }
      if (await posterBlocked(env, name, body.token)) {
        return jsonError(403, "Compte bloqué par l'administrateur");
      }
      const list = await readList(env, MESSAGES_KEY);
      const msg = list.find(m => m && m.id && m.id === String(body.id || ""));
      if (!msg) return jsonError(404, "Message introuvable");
      if (String(msg.name || "").toLowerCase() === name.toLowerCase()) {
        return jsonError(400, "Tu ne peux pas signaler ton propre message");
      }
      const reports = await readList(env, REPORTS_KEY);
      const dup = reports.some(r => r && r.msgId === msg.id && String(r.by || "").toLowerCase() === name.toLowerCase() && r.status !== "traité");
      if (dup) return jsonOk({ ok: true, already: true });
      reports.push({
        id: newMessageId(), msgId: msg.id, msgName: msg.name,
        msgText: String(msg.text || "").slice(0, 200), msgT: msg.t || 0,
        by: name, reason: String(body.reason || "").trim().slice(0, 120),
        t: Date.now(), status: "nouveau",
      });
      while (reports.length > 200) reports.shift();
      await env.CHAT_KV.put(REPORTS_KEY, JSON.stringify(reports));
      return jsonOk({ ok: true });
    }

    // ---------- Signalements : liste (admin) ----------
    if (url.pathname === "/reports/list" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      if (!(await isAdminRequest(env, body.token))) {
        return jsonError(403, "Réservé à l'administrateur");
      }
      const reports = await readList(env, REPORTS_KEY);
      return jsonOk({ reports: reports.slice().reverse() });
    }

    // ---------- Signalements : marquer traité (admin) ----------
    if (url.pathname === "/reports/dismiss" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      if (!(await isAdminRequest(env, body.token))) {
        return jsonError(403, "Réservé à l'administrateur");
      }
      const reports = await readList(env, REPORTS_KEY);
      const rep = reports.find(r => r && r.id === String(body.id || ""));
      if (!rep) return jsonError(404, "Signalement introuvable");
      rep.status = "traité";
      await env.CHAT_KV.put(REPORTS_KEY, JSON.stringify(reports));
      return jsonOk({ ok: true });
    }

    // ---------- Règles de la Discussion : état + acceptation (compte) ----------
    if (url.pathname === "/rules/state" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const acc = await readAccountByToken(env, body.token);
      if (!acc) return jsonError(401, "Connexion requise");
      return jsonOk({ accepted: acc.rulesAccepted === true });
    }
    if (url.pathname === "/rules/accept" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const acc = await readAccountByToken(env, body.token);
      if (!acc) return jsonError(401, "Connexion requise");
      if (acc.rulesAccepted !== true) {
        acc.rulesAccepted = true;
        acc.rulesAcceptedAt = Date.now();
        await writeEmailAccount(env, acc);
      }
      return jsonOk({ ok: true, accepted: true });
    }

    // ---------- Discussion v3 : message épinglé (admin) ----------
    if (url.pathname === "/messages/pin" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      if (!name) return jsonError(400, "Nom manquant");
      if (!(await nameAuthorized(env, name, body.token))) {
        return jsonError(403, "Nom protégé : vérification email requise");
      }
      if (!isAdminName(env, name)) {
        return jsonError(403, "Action réservée à l'administrateur");
      }
      if (body.id === null || body.id === undefined) {
        await env.CHAT_KV.delete(PIN_KEY);
        return jsonOk({ ok: true, pinned: null });
      }
      const list = await readList(env, MESSAGES_KEY);
      const msg = list.find(m => m && m.id && m.id === String(body.id));
      if (!msg) return jsonError(404, "Message introuvable");
      const snapshot = { id: msg.id, name: msg.name, text: msg.text, ts: msg.t };
      await env.CHAT_KV.put(PIN_KEY, JSON.stringify(snapshot));
      return jsonOk({ ok: true, pinned: snapshot });
    }

    if (url.pathname === "/pin" && request.method === "GET") {
      return jsonOk({ pinned: await readPin(env) });
    }

    // ---------- Discussion v3 : présence ----------
    if (url.pathname === "/presence" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      if (!name) return jsonError(400, "Nom manquant");
      if (!(await nameAuthorized(env, name, body.token))) {
        return jsonError(403, "Nom protégé : vérification email requise");
      }
      const now = Date.now();
      const nameLower = name.toLowerCase();
      // Signal "en train d'écrire" (optionnel) : typing:true le rafraîchit,
      // typing:false l'efface, absent = on garde l'état récent.
      let typingTs = 0;
      try {
        const prev = await env.CHAT_KV.get("presence:" + nameLower, "json");
        if (prev && prev.typingTs) typingTs = prev.typingTs;
      } catch (e) { /* lecture facultative */ }
      if (body.typing === true) typingTs = now;
      else if (body.typing === false) typingTs = 0;
      await env.CHAT_KV.put("presence:" + nameLower, JSON.stringify({ name: name, ts: now, typingTs: typingTs }), { expirationTtl: 240 });
      let index = await readList(env, PRESENCE_INDEX_KEY);
      index = index.filter(e => e && e.nameLower && e.nameLower !== nameLower && now - (e.ts || 0) <= PRESENCE_WINDOW_MS);
      index.push({ name: name, nameLower: nameLower, ts: now, typingTs: typingTs });
      index.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      await env.CHAT_KV.put(PRESENCE_INDEX_KEY, JSON.stringify(index.slice(0, 200)));
      return jsonOk({ ok: true });
    }

    if (url.pathname === "/presence" && request.method === "GET") {
      const now = Date.now();
      const index = await readList(env, PRESENCE_INDEX_KEY);
      const seen = new Set();
      const fresh = [];
      for (const e of index) {
        if (!e || !e.name || !e.nameLower) continue;
        if (now - (e.ts || 0) > PRESENCE_WINDOW_MS) continue;
        if (seen.has(e.nameLower)) continue;
        seen.add(e.nameLower);
        fresh.push(e);
      }
      fresh.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      if (fresh.length !== index.length) {
        await env.CHAT_KV.put(PRESENCE_INDEX_KEY, JSON.stringify(fresh.slice(0, 200)));
      }
      const typing = fresh.filter(e => e.typingTs && now - e.typingTs <= 8000).map(e => e.name);
      return jsonOk({ online: fresh.slice(0, 100).map(e => e.name), typing: typing });
    }

    // ---------- Avis (étoiles + commentaires) ----------
    if (url.pathname === "/reviews" && request.method === "GET") {
      const list = await readList(env, REVIEWS_KEY);
      return Response.json(list, { headers: corsHeaders() });
    }

    if (url.pathname === "/reviews" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return new Response("JSON invalide", { status: 400, headers: corsHeaders() });
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      const text = String(body.text || "").trim().slice(0, MAX_REVIEW_TEXT);
      const stars = Math.round(Number(body.stars));
      if (!name || !(stars >= 1 && stars <= 5)) {
        return new Response("Nom ou étoiles manquants", { status: 400, headers: corsHeaders() });
      }
      await registerTrader(env, name);
      if (!(await nameAuthorized(env, name, body.token))) {
        return new Response("Nom protégé : vérification email requise", { status: 403, headers: corsHeaders() });
      }
      if (await posterBlocked(env, name, body.token)) {
        return new Response("Compte bloqué par l'administrateur", { status: 403, headers: corsHeaders() });
      }
      const list = await readList(env, REVIEWS_KEY);
      list.push({ name: name, stars: stars, text: text, t: Date.now() });
      while (list.length > MAX_REVIEWS) list.shift();
      await env.CHAT_KV.put(REVIEWS_KEY, JSON.stringify(list));
      return Response.json({ ok: true }, { headers: corsHeaders() });
    }

    // ---------- Avis : votes « Utile » (bascule par trader) ----------
    if (url.pathname === "/reviews/helpful" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      if (!name) return jsonError(400, "Nom manquant");
      if (!(await nameAuthorized(env, name, body.token))) {
        return jsonError(403, "Nom protégé : vérification requise");
      }
      if (await posterBlocked(env, name, body.token)) {
        return jsonError(403, "Compte bloqué par l'administrateur");
      }
      const target = Number(body.t);
      if (!target) return jsonError(400, "Avis introuvable");
      const list = await readList(env, REVIEWS_KEY);
      const rev = list.find(r => r && r.t === target);
      if (!rev) return jsonError(404, "Avis introuvable");
      if (!rev.helpful || typeof rev.helpful !== "object" || Array.isArray(rev.helpful)) rev.helpful = {};
      const key = name.toLowerCase();
      if (rev.helpful[key]) delete rev.helpful[key];
      else rev.helpful[key] = 1;
      await env.CHAT_KV.put(REVIEWS_KEY, JSON.stringify(list));
      return jsonOk({ ok: true, count: Object.keys(rev.helpful).length, voted: !!rev.helpful[key] });
    }

    // ---------- Avis : réponse de l'équipe (admin seulement) ----------
    if (url.pathname === "/reviews/reply" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      if (!(await isAdminRequest(env, body.token))) {
        return jsonError(403, "Réservé à l'administrateur");
      }
      const target = Number(body.t);
      const text = String(body.text || "").trim().slice(0, MAX_REVIEW_TEXT);
      if (!target || !text) return jsonError(400, "Réponse manquante");
      const list = await readList(env, REVIEWS_KEY);
      const rev = list.find(r => r && r.t === target);
      if (!rev) return jsonError(404, "Avis introuvable");
      rev.reply = { name: adminName(env), text: text, t: Date.now() };
      await env.CHAT_KV.put(REVIEWS_KEY, JSON.stringify(list));
      return jsonOk({ ok: true });
    }

    // ---------- Discussions privées ----------
    if (url.pathname === "/traders" && request.method === "GET") {
      const list = await readList(env, TRADERS_KEY);
      return Response.json(list, { headers: corsHeaders() });
    }

    if (url.pathname === "/private" && request.method === "GET") {
      const me = String(url.searchParams.get("me") || "").trim().slice(0, MAX_NAME);
      const other = String(url.searchParams.get("with") || "").trim().slice(0, MAX_NAME);
      if (!me || !other) {
        return new Response("Paramètres manquants", { status: 400, headers: corsHeaders() });
      }
      const key = pairKey(me, other);
      const list = await readList(env, key);
      // Suivi de lecture privé : read/seen=true quand l'autre a ouvert le fil
      // après l'envoi ; la lecture de l'appelant est enregistrée ensuite
      // (écriture limitée à une fois par 30 s par personne).
      const mkey = "pread:" + key;
      let marks = {};
      try { marks = (await env.CHAT_KV.get(mkey, "json")) || {}; } catch (e) { marks = {}; }
      if (!marks || typeof marks !== "object" || Array.isArray(marks)) marks = {};
      const meL = me.toLowerCase();
      const otherL = other.toLowerCase();
      for (const rec of list) {
        if (!rec || !rec.t) continue;
        const readerMark = rec.from && String(rec.from).toLowerCase() === meL ? (marks[otherL] || 0) : (marks[meL] || 0);
        if (readerMark >= rec.t) {
          rec.read = true;
          rec.seen = true;
        }
      }
      const now = Date.now();
      if (!marks[meL] || now - marks[meL] > 30000) {
        marks[meL] = now;
        await env.CHAT_KV.put(mkey, JSON.stringify(marks));
      }
      return Response.json(list, { headers: corsHeaders() });
    }

    if (url.pathname === "/private" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return new Response("JSON invalide", { status: 400, headers: corsHeaders() });
      const from = String(body.from || "").trim().slice(0, MAX_NAME);
      const to = String(body.to || "").trim().slice(0, MAX_NAME);
      const text = String(body.text || "").trim().slice(0, MAX_TEXT);
      if (!from || !to || (!text && !String(body.voiceId || "")) || from === to) {
        return new Response("Envoi invalide", { status: 400, headers: corsHeaders() });
      }
      if (!(await nameAuthorized(env, from, body.token))) {
        return new Response("Nom protégé : vérification email requise", { status: 403, headers: corsHeaders() });
      }
      if (await posterBlocked(env, from, body.token)) {
        return new Response("Compte bloqué par l'administrateur", { status: 403, headers: corsHeaders() });
      }
      await registerTrader(env, from);
      await registerTrader(env, to);
      const key = pairKey(from, to);
      const list = await readList(env, key);
      const rec = { from: from, to: to, text: text, t: Date.now() };
      const voice = await attachVoice(env, body);
      if (voice) rec.voice = voice;
      if (!text && !voice) {
        return new Response("Envoi invalide", { status: 400, headers: corsHeaders() });
      }
      list.push(rec);
      while (list.length > MAX_PRIVATE) list.shift();
      await env.CHAT_KV.put(key, JSON.stringify(list));
      return Response.json({ ok: true }, { headers: corsHeaders() });
    }

    // ---------- Salons privés (groupes façon Discord, comptes requis) ----------
    if (url.pathname.startsWith("/rooms")) {
      const ROOMS_INDEX_KEY = "rooms:index";
      const MAX_ROOMS_OWNED = 10;
      const MAX_ROOM_MEMBERS = 100;
      const MAX_ROOM_MESSAGES = 300;
      const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      const readRoom = async (id) => {
        if (!id) return null;
        try { return await env.CHAT_KV.get("room:" + id, "json"); } catch (e) { return null; }
      };
      const saveRoom = async (room) => { await env.CHAT_KV.put("room:" + room.id, JSON.stringify(room)); };
      const roomIsMember = (room, nameLower) => (room.members || []).some(m => String(m).toLowerCase() === nameLower);
      const DEFAULT_CHANNELS = [
        { id: "general", name: "général", type: "text" },
        { id: "analyses", name: "analyses", type: "text" },
        { id: "vocal", name: "Salon vocal", type: "voice" },
      ];
      const roomChannels = (room) => {
        const ch = Array.isArray(room.channels) ? room.channels.filter(c => c && c.id && c.name && (c.type === "text" || c.type === "voice")) : [];
        return ch.length ? ch : DEFAULT_CHANNELS.map(c => ({ ...c }));
      };
      const roomTextChannel = (room, id) => roomChannels(room).find(c => c.type === "text" && c.id === id) || null;
      const readNameTsMap = async (key, maxAgeMs) => {
        let map = {};
        try { map = (await env.CHAT_KV.get(key, "json")) || {}; } catch (e) { map = {}; }
        const now = Date.now();
        const out = {};
        for (const k of Object.keys(map || {})) {
          if (map[k] && now - (map[k].ts || 0) <= maxAgeMs) out[k] = map[k];
        }
        return out;
      };
      // Fermeture automatique du salon vocal (règle de Steeve,
      // 2026-11-23) : quand le vocal d'un salon est VIDE, un
      // compteur démarre ; après 5 minutes sans personne, le
      // salon vocal est FERMÉ (le site l'affiche fermé et le
      // prochain « Ouvrir le vocal » le rouvre). L'horodatage
      // du vide vit dans roomvoiceempty:<roomId> : posé la
      // première fois que le moteur voit le vocal vide (départ
      // du dernier membre ou expiration des présences),
      // effacé dès qu'une personne entre dans le vocal.
      const VOICE_CLOSE_MS = 300000;
      const voiceEmptyInfo = async (roomId, voiceMap) => {
        const eKey = "roomvoiceempty:" + roomId;
        const now = Date.now();
        if (voiceMap && Object.keys(voiceMap).length > 0) {
          try { await env.CHAT_KV.delete(eKey); } catch (e) {}
          return { closed: false, emptySince: 0 };
        }
        let since = 0;
        try {
          const raw = await env.CHAT_KV.get(eKey);
          const n = raw ? parseInt(raw, 10) : 0;
          if (isFinite(n) && n > 0) since = n;
        } catch (e) {}
        if (!since) {
          since = now;
          try { await env.CHAT_KV.put(eKey, String(now)); } catch (e) {}
        }
        return { closed: (now - since) >= VOICE_CLOSE_MS, emptySince: since };
      };
      const publicRoom = (room, meLower) => ({
        id: room.id, name: room.name, owner: room.owner,
        members: (room.members || []).length,
        memberNames: room.members || [],
        isOwner: room.ownerLower === meLower,
        code: room.code, createdAt: room.createdAt, invitesOpen: room.invitesOpen !== false,
        channels: roomChannels(room),
        topic: room.topic || "",
        mods: room.mods || [],
      });
      const roomIsMod = (room, nameLower) => (room.mods || []).some(n => String(n).toLowerCase() === nameLower);
      const pushSystemMessage = async (room, text) => {
        const list = await readList(env, "roommsg:" + room.id);
        list.push({ id: newMessageId(), name: "", text: text, t: Date.now(), system: true, channel: "general" });
        while (list.length > MAX_ROOM_MESSAGES) list.shift();
        await env.CHAT_KV.put("roommsg:" + room.id, JSON.stringify(list));
      };
      // Session de compte v2 obligatoire pour les salons.
      const roomSession = async (token) => {
        const acc = await readAccountByToken(env, token || "");
        if (!acc || !acc.name) return { error: [401, "Connexion requise"] };
        if (acc.blocked) return { error: [403, "Compte bloqué par l'administrateur"] };
        return { acc: acc };
      };
      const roomGate = async (token, roomId) => {
        const s = await roomSession(token);
        if (s.error) return s;
        const room = await readRoom(roomId);
        if (!room) return { error: [404, "Salon introuvable"] };
        if (!roomIsMember(room, s.acc.name.toLowerCase())) return { error: [403, "Tu n'es pas membre de ce salon"] };
        return { acc: s.acc, room: room };
      };

      if (url.pathname === "/rooms/preview" && request.method === "GET") {
        const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
        if (!code) return jsonError(400, "Code manquant");
        /* Invitation par code : 5 essais rates par minute et par adresse IP. */
        const ip = String(request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim() || "unknown";
        const rlKey = "ratelimit:preview:" + ip;
        let rl = null;
        try { rl = await env.CHAT_KV.get(rlKey, "json"); } catch (e) { rl = null; }
        const nowMs = Date.now();
        if (!rl || !rl.windowStart || (nowMs - rl.windowStart) > 60000) rl = { count: 0, windowStart: nowMs };
        if (rl.count >= 5) return jsonError(429, "Trop d'essais, réessaie dans 60 s");
        const roomId = await env.CHAT_KV.get("roomcode:" + code);
        const room = roomId ? await readRoom(roomId) : null;
        if (!room) {
          rl.count++;
          try { await env.CHAT_KV.put(rlKey, JSON.stringify(rl)); } catch (e) {}
          return jsonError(404, "Invitation introuvable");
        }
        try { await env.CHAT_KV.delete(rlKey); } catch (e) {}
        let already = false;
        const tok = String(url.searchParams.get("token") || "");
        if (tok) {
          const s2 = await roomSession(tok);
          if (!s2.error) already = roomIsMember(room, s2.acc.name.toLowerCase());
        }
        return jsonOk({ name: room.name, owner: room.owner, members: room.members.length, invitesOpen: room.invitesOpen !== false, alreadyMember: already });
      }

      if (url.pathname === "/rooms" && request.method === "GET") {
        const s = await roomSession(url.searchParams.get("token") || "");
        if (s.error) return jsonError(s.error[0], s.error[1]);
        const meLower = s.acc.name.toLowerCase();
        const ids = await readList(env, ROOMS_INDEX_KEY);
        const out = [];
        for (const id of ids.slice(-200)) {
          const room = await readRoom(id);
          if (room && roomIsMember(room, meLower)) {
            const view = publicRoom(room, meLower);
            const photos = {};
            for (const n of (room.members || [])) {
              const pid = await env.CHAT_KV.get("photoBy:" + String(n).toLowerCase());
              if (pid) photos[String(n).toLowerCase()] = pid;
            }
            view.memberPhotos = photos;
            const vm = await readNameTsMap("roomvoice:" + room.id, 50000);
            view.voiceMembers = Object.values(vm).map(v => v.name);
            const vei3 = await voiceEmptyInfo(room.id, vm);
            view.voiceClosed = vei3.closed;
            out.push(view);
          }
        }
        return jsonOk({ rooms: out });
      }

      if (url.pathname === "/rooms/create" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const s = await roomSession(body.token);
        if (s.error) return jsonError(s.error[0], s.error[1]);
        const name = String(body.name || "").trim().slice(0, 60);
        if (name.length < 2) return jsonError(400, "Nom du salon trop court");
        const meLower = s.acc.name.toLowerCase();
        const ids = await readList(env, ROOMS_INDEX_KEY);
        let owned = 0;
        for (const id of ids.slice(-200)) {
          const r = await readRoom(id);
          if (r && r.ownerLower === meLower) owned++;
        }
        if (owned >= MAX_ROOMS_OWNED) return jsonError(403, "Limite de salons créés atteinte");
        let code = "";
        for (let attempt = 0; attempt < 8 && !code; attempt++) {
          let candidate = "";
          const rand = new Uint8Array(6);
          crypto.getRandomValues(rand);
          for (const b of rand) candidate += CODE_ALPHABET[b % CODE_ALPHABET.length];
          const taken = await env.CHAT_KV.get("roomcode:" + candidate);
          if (!taken) code = candidate;
        }
        if (!code) return jsonError(500, "Réessaie la création du salon");
        const room = {
          id: newMessageId(), name: name,
          owner: s.acc.name, ownerLower: meLower,
          code: code, members: [s.acc.name], createdAt: Date.now(), invitesOpen: true,
          channels: DEFAULT_CHANNELS.map(c => ({ ...c })),
        };
        await saveRoom(room);
        await env.CHAT_KV.put("roomcode:" + code, room.id);
        ids.push(room.id);
        await env.CHAT_KV.put(ROOMS_INDEX_KEY, JSON.stringify(ids.slice(-500)));
        return jsonOk({ ok: true, room: publicRoom(room, meLower) });
      }

      if (url.pathname === "/rooms/join" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const s = await roomSession(body.token);
        if (s.error) return jsonError(s.error[0], s.error[1]);
        const code = String(body.code || "").trim().toUpperCase().slice(0, 12);
        if (!code) return jsonError(400, "Code manquant");
        const roomId = await env.CHAT_KV.get("roomcode:" + code);
        const room = roomId ? await readRoom(roomId) : null;
        if (!room) return jsonError(404, "Code invalide : aucun salon avec ce code");
        const meLower = s.acc.name.toLowerCase();
        if (roomIsMember(room, meLower)) {
          return jsonOk({ ok: true, already: true, room: publicRoom(room, meLower) });
        }
        if (room.invitesOpen === false) return jsonError(403, "Ce salon n'accepte plus d'invitations.");
        if ((room.members || []).length >= MAX_ROOM_MEMBERS) return jsonError(403, "Salon plein");
        room.members.push(s.acc.name);
        await saveRoom(room);
        await pushSystemMessage(room, s.acc.name + " a rejoint le salon");
        return jsonOk({ ok: true, room: publicRoom(room, meLower) });
      }

      /* Invitation par code : regenerer le code (l'ancien devient
         invalide, les membres restent) — createur du salon ou admin. */
      if (url.pathname === "/rooms/code" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const s = await roomSession(body.token);
        if (s.error) return jsonError(s.error[0], s.error[1]);
        const room = await readRoom(String(body.room || ""));
        if (!room) return jsonError(404, "Salon introuvable");
        const meLower = s.acc.name.toLowerCase();
        if (room.ownerLower !== meLower && !isAdminName(env, s.acc.name)) {
          return jsonError(403, "Seul le créateur du salon peut changer le code");
        }
        let code = "";
        for (let attempt = 0; attempt < 8 && !code; attempt++) {
          let candidate = "";
          const rand = new Uint8Array(6);
          crypto.getRandomValues(rand);
          for (const b of rand) candidate += CODE_ALPHABET[b % CODE_ALPHABET.length];
          const taken = await env.CHAT_KV.get("roomcode:" + candidate);
          if (!taken) code = candidate;
        }
        if (!code) return jsonError(500, "Réessaie la création du code");
        await env.CHAT_KV.delete("roomcode:" + room.code);
        room.code = code;
        await saveRoom(room);
        await env.CHAT_KV.put("roomcode:" + code, room.id);
        return jsonOk({ ok: true, code: code });
      }

      /* Invitation par code : ouvrir / fermer les invitations. */
      if (url.pathname === "/rooms/invites" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const s = await roomSession(body.token);
        if (s.error) return jsonError(s.error[0], s.error[1]);
        const room = await readRoom(String(body.room || ""));
        if (!room) return jsonError(404, "Salon introuvable");
        const meLower = s.acc.name.toLowerCase();
        if (room.ownerLower !== meLower && !isAdminName(env, s.acc.name)) {
          return jsonError(403, "Seul le créateur du salon peut changer les invitations");
        }
        room.invitesOpen = body.open !== false;
        await saveRoom(room);
        return jsonOk({ ok: true, invitesOpen: room.invitesOpen });
      }

      // Signalisation de l'appel vocal PEASET (WebRTC entre membres) :
      // boîtes aux lettres par membre, lues puis vidées à chaque passage.
      // Configuration ICE pour le vocal : STUN publics + relais TURN si les
      // variables TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL sont posées.
      if (url.pathname === "/rooms/ice" && request.method === "GET") {
        const g = await roomGate(url.searchParams.get("token") || "", String(url.searchParams.get("room") || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const servers = [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun.cloudflare.com:3478" }
        ];
        /* Relais TURN Cloudflare Realtime (activé le
           2026-11-23 à la demande de Steeve) : quand les
           secrets TURN_KEY_ID + TURN_API_TOKEN sont présents
           dans les réglages du moteur, on génère des
           identifiants éphémères (24 h) que le site reçoit —
           la clé elle-même ne quitte jamais le moteur. Sans
           les secrets, ou si Cloudflare ne répond pas, on
           retombe sur les STUN seuls, comme avant. */
        if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
          try {
            const nowT = Date.now();
            if (!TURN_CACHE.servers || nowT - TURN_CACHE.at > 12 * 3600 * 1000) {
              const respT = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + encodeURIComponent(String(env.TURN_KEY_ID)) + "/credentials/generate-ice-servers", {
                method: "POST",
                headers: { "Authorization": "Bearer " + String(env.TURN_API_TOKEN), "Content-Type": "application/json" },
                body: JSON.stringify({ ttl: 86400 })
              });
              if (respT.ok) {
                const dataT = await respT.json();
                if (dataT && Array.isArray(dataT.iceServers) && dataT.iceServers.length) {
                  TURN_CACHE = { at: nowT, servers: dataT.iceServers };
                }
              }
            }
            if (TURN_CACHE.servers) for (const sT of TURN_CACHE.servers) servers.push(sT);
          } catch (e) {}
        }
        if (env.TURN_URLS) {
          servers.push({
            urls: String(env.TURN_URLS).split(",").map(s => s.trim()).filter(Boolean),
            username: env.TURN_USERNAME || "",
            credential: env.TURN_CREDENTIAL || ""
          });
        }
        return jsonOk({ iceServers: servers });
      }

      if (url.pathname === "/rooms/call" && request.method === "GET") {
        const g = await roomGate(url.searchParams.get("token") || "", String(url.searchParams.get("room") || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        /* Boîte aux lettres SANS course (2026-11-23) : chaque
           message vit sous sa propre clé ; on liste, on lit,
           on supprime. L'ancien « lire la liste puis la
           réécrire » écrasait les messages envoyés en rafale
           au même moment — surtout les candidats ICE, perdus
           avant même d'être lus, ce qui laissait le vocal
           bloqué sur « en connexion… ». */
        const prefix = "callbox:" + g.room.id + ":" + g.acc.name.toLowerCase() + ":";
        const listed = await env.CHAT_KV.list({ prefix: prefix, limit: 200 });
        const items = [];
        for (const k of listed.keys) {
          const raw = await env.CHAT_KV.get(k.name);
          await env.CHAT_KV.delete(k.name);
          if (!raw) continue;
          try { const it = JSON.parse(raw); if (it && (Date.now() - (it.t || 0)) < 120000) items.push(it); } catch (e) {}
        }
        items.sort((a, b) => (a.t || 0) - (b.t || 0));
        return jsonOk({ items: items });
      }

      if (url.pathname === "/rooms/call" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const to = String(body.to || "").trim().toLowerCase();
        if (!to || to === g.acc.name.toLowerCase()) return jsonError(400, "Destinataire invalide");
        if (!roomIsMember(g.room, to)) return jsonError(404, "Ce trader n'est pas membre du salon");
        const data = body.data;
        if (!data || typeof data !== "object" || ["offer", "answer", "ice", "bye", "sign"].indexOf(String(data.type || "")) < 0) {
          return jsonError(400, "Signal invalide");
        }
        const key = "callbox:" + g.room.id + ":" + to;
        const item = { from: g.acc.name, data: JSON.parse(JSON.stringify(data).slice(0, 20000)), t: Date.now() };
        const mkey = key + ":" + item.t + "-" + Math.random().toString(36).slice(2, 10);
        await env.CHAT_KV.put(mkey, JSON.stringify(item), { expirationTtl: 180 });
        return jsonOk({ ok: true });
      }

      // Description du salon (créateur ou admin).
      if (url.pathname === "/rooms/topic" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const meLower = g.acc.name.toLowerCase();
        if (!(g.room.ownerLower === meLower || isAdminName(env, g.acc.name))) {
          return jsonError(403, "Seul le créateur du salon peut changer la description");
        }
        g.room.topic = String(body.topic || "").trim().slice(0, 120);
        await saveRoom(g.room);
        return jsonOk({ ok: true, topic: g.room.topic });
      }

      // Modérateurs du salon (créateur ou admin) : ils peuvent épingler et
      // effacer les messages des autres.
      if (url.pathname === "/rooms/moderator" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const meLower = g.acc.name.toLowerCase();
        if (!(g.room.ownerLower === meLower || isAdminName(env, g.acc.name))) {
          return jsonError(403, "Seul le créateur du salon peut nommer un modérateur");
        }
        const target = String(body.name || "").trim();
        const targetLower = target.toLowerCase();
        if (!target || targetLower === g.room.ownerLower) return jsonError(400, "Membre invalide");
        if (!roomIsMember(g.room, targetLower)) return jsonError(404, "Ce trader n'est pas membre du salon");
        const memberName = (g.room.members || []).find(n => String(n).toLowerCase() === targetLower);
        let mods = Array.isArray(g.room.mods) ? g.room.mods.slice() : [];
        if (body.mod) {
          if (!mods.some(n => String(n).toLowerCase() === targetLower)) mods.push(memberName);
        } else {
          mods = mods.filter(n => String(n).toLowerCase() !== targetLower);
        }
        g.room.mods = mods;
        await saveRoom(g.room);
        return jsonOk({ ok: true, mods: mods });
      }

      // Événements du salon (sessions de trading) : création par le créateur,
      // les modérateurs ou l'admin ; participation ouverte à tous les membres.
      if (url.pathname === "/rooms/events" && request.method === "GET") {
        const g = await roomGate(url.searchParams.get("token") || "", String(url.searchParams.get("room") || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const key = "roomevents:" + g.room.id;
        let events = await readList(env, key);
        const cutoff = Date.now() - 2 * 3600 * 1000;
        const kept = events.filter(e => e && e.ts > cutoff);
        if (kept.length !== events.length) await env.CHAT_KV.put(key, JSON.stringify(kept));
        kept.sort((a, b) => a.ts - b.ts);
        return jsonOk({ events: kept });
      }

      if (url.pathname === "/rooms/events" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const meLower = g.acc.name.toLowerCase();
        if (!(g.room.ownerLower === meLower || isAdminName(env, g.acc.name) || roomIsMod(g.room, meLower))) {
          return jsonError(403, "Seuls le créateur et les modérateurs créent des événements");
        }
        const title = String(body.title || "").trim().slice(0, 80);
        const ts = parseInt(body.ts, 10) || 0;
        if (title.length < 3) return jsonError(400, "Titre trop court");
        if (!(ts > Date.now() - 3600 * 1000)) return jsonError(400, "Date de l'événement invalide");
        const key = "roomevents:" + g.room.id;
        const events = await readList(env, key);
        const ev = { id: newMessageId(), title: title, ts: ts, by: g.acc.name, interested: [] };
        events.push(ev);
        await env.CHAT_KV.put(key, JSON.stringify(events.slice(-50)));
        return jsonOk({ ok: true, event: ev });
      }

      if (url.pathname === "/rooms/events/interest" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const key = "roomevents:" + g.room.id;
        const events = await readList(env, key);
        const ev = events.find(e => e && e.id === String(body.id || ""));
        if (!ev) return jsonError(404, "Événement introuvable");
        ev.interested = Array.isArray(ev.interested) ? ev.interested : [];
        const idx = ev.interested.indexOf(g.acc.name);
        if (idx >= 0) ev.interested.splice(idx, 1); else ev.interested.push(g.acc.name);
        await env.CHAT_KV.put(key, JSON.stringify(events));
        return jsonOk({ ok: true, interested: ev.interested });
      }

      if (url.pathname === "/rooms/events/delete" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const key = "roomevents:" + g.room.id;
        const events = await readList(env, key);
        const ev = events.find(e => e && e.id === String(body.id || ""));
        if (!ev) return jsonError(404, "Événement introuvable");
        const meLower = g.acc.name.toLowerCase();
        const canDelete = g.room.ownerLower === meLower || isAdminName(env, g.acc.name) || roomIsMod(g.room, meLower) || ev.by === g.acc.name;
        if (!canDelete) return jsonError(403, "Suppression non autorisée");
        await env.CHAT_KV.put(key, JSON.stringify(events.filter(e => e.id !== ev.id)));
        return jsonOk({ ok: true });
      }

      // État vivant du salon : qui écrit (par salon texte), qui est dans le vocal.
      if (url.pathname === "/rooms/state" && request.method === "GET") {
        const g = await roomGate(url.searchParams.get("token") || "", String(url.searchParams.get("room") || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const ch = String(url.searchParams.get("channel") || "general");
        const meLower = g.acc.name.toLowerCase();
        const typingMap = await readNameTsMap("roomtyping:" + g.room.id, 6000);
        const typing = Object.values(typingMap).filter(v => v.channel === ch && v.name.toLowerCase() !== meLower).map(v => v.name);
        const voiceMap = await readNameTsMap("roomvoice:" + g.room.id, 50000);
        const voiceMembers = Object.values(voiceMap).map(v => v.name);
        const vei = await voiceEmptyInfo(g.room.id, voiceMap);
        return jsonOk({ typing: typing, voiceMembers: voiceMembers, voiceClosed: vei.closed, channels: roomChannels(g.room) });
      }

      if (url.pathname === "/rooms/typing" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const key = "roomtyping:" + g.room.id;
        const map = await readNameTsMap(key, 6000);
        map[g.acc.name.toLowerCase()] = { name: g.acc.name, channel: String(body.channel || "general"), ts: Date.now() };
        await env.CHAT_KV.put(key, JSON.stringify(map));
        return jsonOk({ ok: true });
      }

      // Présence vocale : le site signale l'entrée/sortie de la scène vocale et
      // refait un signal toutes les ~20 s pendant que la personne est dedans.
      if (url.pathname === "/rooms/voice" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const key = "roomvoice:" + g.room.id;
        const map = await readNameTsMap(key, 50000);
        const meLower = g.acc.name.toLowerCase();
        if (body.inside) map[meLower] = { name: g.acc.name, ts: Date.now() };
        else delete map[meLower];
        await env.CHAT_KV.put(key, JSON.stringify(map));
        const vei2 = await voiceEmptyInfo(g.room.id, map);
        return jsonOk({ ok: true, voiceMembers: Object.values(map).map(v => v.name), voiceClosed: vei2.closed });
      }

      // Salons texte supplémentaires (créateur ou admin), façon Discord.
      if (url.pathname === "/rooms/channels" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const meLower = g.acc.name.toLowerCase();
        if (!(g.room.ownerLower === meLower || isAdminName(env, g.acc.name))) {
          return jsonError(403, "Seul le créateur du salon peut ajouter un salon texte");
        }
        const name = String(body.name || "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, 30);
        if (name.length < 2) return jsonError(400, "Nom du salon trop court");
        const channels = roomChannels(g.room);
        if (channels.filter(c => c.type === "text").length >= 8) return jsonError(403, "Trop de salons texte");
        if (channels.some(c => c.name.toLowerCase() === name)) return jsonError(400, "Un salon porte déjà ce nom");
        const id = "c" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
        channels.push({ id: id, name: name, type: "text" });
        g.room.channels = channels;
        await saveRoom(g.room);
        return jsonOk({ ok: true, channels: channels });
      }

      if (url.pathname === "/rooms/channels/delete" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const meLower = g.acc.name.toLowerCase();
        if (!(g.room.ownerLower === meLower || isAdminName(env, g.acc.name))) {
          return jsonError(403, "Seul le créateur du salon peut supprimer un salon texte");
        }
        const target = String(body.channel || "");
        if (target === "general") return jsonError(400, "Le salon #général ne peut pas être supprimé");
        const channels = roomChannels(g.room);
        const kept = channels.filter(c => !(c.id === target && c.type === "text"));
        if (kept.length === channels.length) return jsonError(404, "Salon texte introuvable");
        g.room.channels = kept;
        await saveRoom(g.room);
        const list = await readList(env, "roommsg:" + g.room.id);
        await env.CHAT_KV.put("roommsg:" + g.room.id, JSON.stringify(list.filter(m => (m.channel || "general") !== target)));
        return jsonOk({ ok: true, channels: kept });
      }

      if (url.pathname === "/rooms/pins" && request.method === "GET") {
        const g = await roomGate(url.searchParams.get("token") || "", String(url.searchParams.get("room") || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const ch = String(url.searchParams.get("channel") || "general");
        const list = await readList(env, "roommsg:" + g.room.id);
        return jsonOk({ pins: list.filter(m => m.pinned && (m.channel || "general") === ch) });
      }

      if (url.pathname === "/rooms/messages" && request.method === "GET") {
        const g = await roomGate(url.searchParams.get("token") || "", String(url.searchParams.get("room") || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const ch = String(url.searchParams.get("channel") || "general");
        const list = await readList(env, "roommsg:" + g.room.id);
        return Response.json(list.filter(m => (m.channel || "general") === ch), { headers: corsHeaders() });
      }

      if (url.pathname === "/rooms/messages" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const text = String(body.text || "").trim().slice(0, MAX_TEXT);
        const voice = await attachVoice(env, body);
        let poll = null;
        if (!voice && body.poll && typeof body.poll === "object") {
          const q = String(body.poll.question || "").trim().slice(0, 120);
          const opts = (Array.isArray(body.poll.options) ? body.poll.options : [])
            .map(o => String(o || "").trim().slice(0, 40)).filter(Boolean).slice(0, 4);
          if (q && opts.length >= 2) poll = { q: q, options: opts.map(t => ({ text: t, votes: [] })) };
        }
        const hasAnalysis = !!(body.analysis && typeof body.analysis === "object" && String(body.analysis.pair || "").trim());
        if (!text && !voice && !poll && !hasAnalysis) return jsonError(400, "Message vide");
        const list = await readList(env, "roommsg:" + g.room.id);
        const msg = { id: newMessageId(), name: g.acc.name, text: text, t: Date.now() };
        const chId = String(body.channel || "general");
        msg.channel = roomTextChannel(g.room, chId) ? chId : "general";
        if (poll) { msg.type = "poll"; msg.poll = poll; }
        if (!voice && !poll && body.analysis && typeof body.analysis === "object") {
          const a = {};
          for (const k of ["pair", "dir", "entry", "sl", "tp", "reason"]) a[k] = String(body.analysis[k] || "").slice(0, 80);
          if (a.pair) msg.analysis = a;
        }
        const avatar = String(body.avatar || "").trim();
        if (avatar && avatar.length <= 30) msg.avatar = avatar;
        if (voice) msg.voice = voice;
        const photoId = String(body.photoId || "").trim();
        if (photoId && photoId.length <= 40) msg.photo = photoId;
        if (body.replyTo) {
          const target = list.find(m => m && m.id && m.id === String(body.replyTo));
          if (target) {
            msg.reply = { id: target.id, name: target.name, text: String(target.text || "").slice(0, 80) };
          }
        }
        list.push(msg);
        while (list.length > MAX_ROOM_MESSAGES) list.shift();
        await env.CHAT_KV.put("roommsg:" + g.room.id, JSON.stringify(list));
        return jsonOk({ ok: true });
      }

      if (url.pathname === "/rooms/messages/delete" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const target = String(body.id || "");
        if (!target) return jsonError(400, "Message introuvable");
        const meLower = g.acc.name.toLowerCase();
        const canModerate = g.room.ownerLower === meLower || isAdminName(env, g.acc.name) || roomIsMod(g.room, meLower);
        const list = await readList(env, "roommsg:" + g.room.id);
        const kept = list.filter(m => {
          if (!m || m.id !== target) return true;
          return !(canModerate || String(m.name || "").toLowerCase() === meLower);
        });
        if (kept.length === list.length) return jsonError(403, "Suppression non autorisée");
        await env.CHAT_KV.put("roommsg:" + g.room.id, JSON.stringify(kept));
        return jsonOk({ ok: true });
      }

      if (url.pathname === "/rooms/messages/react" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const emoji = String(body.emoji || "");
        if (!emoji || emoji.length > 12 || /[a-zA-Z0-9]/.test(emoji)) return jsonError(400, "Réaction inconnue");
        const list = await readList(env, "roommsg:" + g.room.id);
        const msg = list.find(m => m && m.id && m.id === String(body.id || ""));
        if (!msg) return jsonError(404, "Message introuvable");
        if (!msg.reactions || typeof msg.reactions !== "object") msg.reactions = {};
        const arr = Array.isArray(msg.reactions[emoji]) ? msg.reactions[emoji] : [];
        const idx = arr.indexOf(g.acc.name);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(g.acc.name);
        if (arr.length > 0) msg.reactions[emoji] = arr; else delete msg.reactions[emoji];
        await env.CHAT_KV.put("roommsg:" + g.room.id, JSON.stringify(list));
        return jsonOk({ ok: true, reactions: msg.reactions });
      }

      // Épingler / désépingler (créateur du salon ou admin), façon Discord.
      if (url.pathname === "/rooms/messages/pin" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const meLower = g.acc.name.toLowerCase();
        if (!(g.room.ownerLower === meLower || isAdminName(env, g.acc.name) || roomIsMod(g.room, meLower))) {
          return jsonError(403, "Seuls le créateur et les modérateurs peuvent épingler");
        }
        const list = await readList(env, "roommsg:" + g.room.id);
        const msg = list.find(m => m && m.id && m.id === String(body.id || ""));
        if (!msg) return jsonError(404, "Message introuvable");
        msg.pinned = !msg.pinned;
        await env.CHAT_KV.put("roommsg:" + g.room.id, JSON.stringify(list));
        return jsonOk({ ok: true, pinned: !!msg.pinned });
      }

      // Vote sur un sondage : un seul choix par membre, modifiable.
      if (url.pathname === "/rooms/messages/poll-vote" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const list = await readList(env, "roommsg:" + g.room.id);
        const msg = list.find(m => m && m.id && m.id === String(body.id || ""));
        if (!msg || msg.type !== "poll" || !msg.poll) return jsonError(404, "Sondage introuvable");
        const idx = parseInt(body.option, 10);
        if (!(idx >= 0 && idx < msg.poll.options.length)) return jsonError(400, "Choix invalide");
        for (const opt of msg.poll.options) {
          opt.votes = (opt.votes || []).filter(n => n !== g.acc.name);
        }
        msg.poll.options[idx].votes.push(g.acc.name);
        await env.CHAT_KV.put("roommsg:" + g.room.id, JSON.stringify(list));
        return jsonOk({ ok: true, poll: msg.poll });
      }

      // Modifier son propre message (mention « modifié »), façon Discord.
      if (url.pathname === "/rooms/messages/edit" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const text = String(body.text || "").trim().slice(0, MAX_TEXT);
        if (!text) return jsonError(400, "Message vide");
        const list = await readList(env, "roommsg:" + g.room.id);
        const msg = list.find(m => m && m.id && m.id === String(body.id || ""));
        if (!msg) return jsonError(404, "Message introuvable");
        if (String(msg.name || "").toLowerCase() !== g.acc.name.toLowerCase()) {
          return jsonError(403, "Tu ne peux modifier que tes messages");
        }
        msg.text = text;
        msg.edited = true;
        await env.CHAT_KV.put("roommsg:" + g.room.id, JSON.stringify(list));
        return jsonOk({ ok: true });
      }

      // Fils de discussion : réponses attachées à un message, façon Discord.
      if (url.pathname === "/rooms/thread" && request.method === "GET") {
        const g = await roomGate(url.searchParams.get("token") || "", String(url.searchParams.get("room") || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const parent = String(url.searchParams.get("parent") || "");
        const list = await readList(env, "roommsg:" + g.room.id);
        const parentMsg = list.find(m => m && m.id && m.id === parent);
        if (!parentMsg) return jsonError(404, "Message parent introuvable");
        const thread = await readList(env, "roomthread:" + g.room.id + ":" + parent);
        return jsonOk({ parent: parentMsg, messages: thread });
      }

      if (url.pathname === "/rooms/thread/messages" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const parent = String(body.parent || "");
        const text = String(body.text || "").trim().slice(0, MAX_TEXT);
        const voice = await attachVoice(env, body);
        if (!text && !voice) return jsonError(400, "Message vide");
        const list = await readList(env, "roommsg:" + g.room.id);
        const parentMsg = list.find(m => m && m.id && m.id === parent);
        if (!parentMsg) return jsonError(404, "Message parent introuvable");
        const key = "roomthread:" + g.room.id + ":" + parent;
        const thread = await readList(env, key);
        const msg = { id: newMessageId(), name: g.acc.name, text: text, t: Date.now() };
        const avatar = String(body.avatar || "").trim();
        if (avatar && avatar.length <= 30) msg.avatar = avatar;
        if (voice) msg.voice = voice;
        const photoId = String(body.photoId || "").trim();
        if (photoId && photoId.length <= 40) msg.photo = photoId;
        thread.push(msg);
        while (thread.length > 200) thread.shift();
        await env.CHAT_KV.put(key, JSON.stringify(thread));
        parentMsg.threadCount = thread.length;
        await env.CHAT_KV.put("roommsg:" + g.room.id, JSON.stringify(list));
        return jsonOk({ ok: true });
      }

      if (url.pathname === "/rooms/leave" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        if (g.room.ownerLower === g.acc.name.toLowerCase()) {
          return jsonError(400, "Le créateur ne peut pas quitter son salon : supprime-le");
        }
        g.room.members = (g.room.members || []).filter(m => String(m).toLowerCase() !== g.acc.name.toLowerCase());
        await saveRoom(g.room);
        await pushSystemMessage(g.room, g.acc.name + " a quitté le salon");
        return jsonOk({ ok: true });
      }

      if (url.pathname === "/rooms/remove" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const g = await roomGate(body.token, String(body.room || ""));
        if (g.error) return jsonError(g.error[0], g.error[1]);
        const meLower = g.acc.name.toLowerCase();
        if (g.room.ownerLower !== meLower && !isAdminName(env, g.acc.name)) {
          return jsonError(403, "Seul le créateur du salon peut retirer un membre");
        }
        const target = String(body.name || "").trim().toLowerCase();
        const targetName = (g.room.members || []).find(m => String(m).toLowerCase() === target);
        if (!target || target === g.room.ownerLower) return jsonError(400, "Membre introuvable");
        g.room.members = (g.room.members || []).filter(m => String(m).toLowerCase() !== target);
        g.room.mods = (g.room.mods || []).filter(n => String(n).toLowerCase() !== target);
        await saveRoom(g.room);
        if (targetName) await pushSystemMessage(g.room, targetName + " a été retiré du salon");
        return jsonOk({ ok: true });
      }

      if (url.pathname === "/rooms/delete" && request.method === "POST") {
        const body = await parseBody(request);
        if (!body) return jsonError(400, "JSON invalide");
        const s = await roomSession(body.token);
        if (s.error) return jsonError(s.error[0], s.error[1]);
        const room = await readRoom(String(body.room || ""));
        if (!room) return jsonError(404, "Salon introuvable");
        const meLower = s.acc.name.toLowerCase();
        if (room.ownerLower !== meLower && !isAdminName(env, s.acc.name)) {
          return jsonError(403, "Seul le créateur du salon peut le supprimer");
        }
        await env.CHAT_KV.delete("room:" + room.id);
        await env.CHAT_KV.delete("roommsg:" + room.id);
        await env.CHAT_KV.delete("roomcode:" + room.code);
        const ids = await readList(env, ROOMS_INDEX_KEY);
        await env.CHAT_KV.put(ROOMS_INDEX_KEY, JSON.stringify(ids.filter(i => i !== room.id)));
        return jsonOk({ ok: true });
      }

      return jsonError(404, "Route salons inconnue");
    }

    // ---------- Assistante IA (Cloudflare Workers AI, gratuit) ----------
    if (url.pathname === "/assistant" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const session = await readAccountByToken(env, body.token || "");
      if (!session) return jsonError(401, "Connexion requise");
      if (session.blocked) return jsonError(403, "Compte bloqué par l'administrateur");
      const question = String(body.q || "").trim().slice(0, 600);
      if (question.length < 2) return jsonError(400, "Question trop courte");
      if (!env.AI) return jsonError(503, "Assistante IA pas encore activée");
      const lang = body.lang === "ht" ? "ht" : "fr";
      // Choix des sujets de la base du site qui correspondent à la question (prompt court et fidèle)
      const normQ = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const nq = normQ(question);
      const scored = [];
      const assistantKb = await getAssistantKb(env);
      for (const t of assistantKb) {
        let sc = 0;
        for (const k of t.kw || []) {
          const nk = normQ(k);
          if (nk.length >= 3 && nq.includes(nk)) sc += 4 + nk.split(" ").length;
        }
        const faqWords = normQ(lang === "ht" ? t.faqHt : t.faqFr).split(/[^a-z0-9]+/).filter(w => w.length >= 4);
        for (const w of faqWords) if (nq.includes(w)) sc += 1;
        if (sc >= 4) scored.push({ t, sc });
      }
      scored.sort((a, b) => b.sc - a.sc);
      const kb = scored.slice(0, 3).map(({ t }) => "## " + (lang === "ht" ? (t.faqHt || t.faqFr) : t.faqFr) + "\n" + (lang === "ht" ? (t.ht || t.fr) : t.fr)).join("\n\n");
      const systemLines = [
        "Tu es l'Assistante PEASET, l'assistante du site PEASET Calculator, créé par Steeve Pascal.",
        lang === "ht"
          ? "Reponn nan kreyòl ayisyen, senp epi klè."
          : "Réponds en français simple et clair.",
        "Tu aides sur le trading (définitions : point, pip, lot, levier, marge, stop loss, take profit, risque) et sur l'utilisation du site PEASET Calculator (calculatrice, journal, résultats, communauté, dons, compte).",
        "RÈGLE ABSOLUE : tu ne fais JAMAIS de calcul. Pas de taille de lot, pas de conversion de points ou pips en argent, pas d'exemple chiffré de trade calculé. Si on te demande un calcul, réponds UNIQUEMENT par : « Fais ce calcul dans la calculatrice ».",
        "Tu ne donnes JAMAIS de signal ni de conseil pour un trade précis : personne ne peut savoir à l'avance si un trade va gagner ou perdre.",
        "Réponses courtes : 2 à 6 phrases maximum. Aucune promesse de gain : le trading comporte des risques de perte.",
        "Si on te demande qui t'a créé, réponds : Steeve Pascal."
      ];
      if (kb) {
        systemLines.push("", "BASE DE CONNAISSANCES DU SITE — les réponses officielles de PEASET Calculator suivent. Quand la question touche un de ces sujets, base ta réponse sur ce contenu : reprends les faits fidèlement, avec tes propres phrases si c'est plus naturel. Ne contredis jamais ces réponses et n'invente aucun autre chiffre, prix ou numéro.", kb);
      }
      const system = systemLines.join("\n");
      const askAI = async (model) => {
        const out = await env.AI.run(model, {
          messages: [
            { role: "system", content: system },
            { role: "user", content: question }
          ],
          max_tokens: 800,
          temperature: 0.4
        });
        let text = "";
        if (out && typeof out.response === "string") text = out.response;
        else if (out && out.choices && out.choices[0] && out.choices[0].message && typeof out.choices[0].message.content === "string") text = out.choices[0].message.content;
        text = String(text || "").trim();
        if (!text) throw new Error("ai vide");
        return text.slice(0, 2000);
      };
      try {
        let answer;
        try { answer = await askAI("@cf/openai/gpt-oss-120b"); }
        catch (e) { answer = await askAI("@cf/meta/llama-3.3-70b-instruct-fp8-fast"); }
        return jsonOk({ answer: answer });
      } catch (e) {
        return jsonError(502, "Assistante IA indisponible pour le moment");
      }
    }

    // ---------- Email : enregistrement et récupération ----------
    if (url.pathname === "/email/register" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return new Response("JSON invalide", { status: 400, headers: corsHeaders() });
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return new Response("Nom ou email invalide", { status: 400, headers: corsHeaders() });
      }
      const existing = await readAccount(env, name);
      if (existing && existing.emailVerified && existing.email !== email) {
        return new Response("Un email vérifié existe déjà pour ce nom", { status: 409, headers: corsHeaders() });
      }
      const issued = await issueCode(env, name, "verify");
      if (issued.error === "wait") {
        return new Response("Attends une minute avant un nouveau code", { status: 429, headers: corsHeaders() });
      }
      const sent = await sendEmail(env, email,
        "PEASET Calculator — ton code de vérification",
        "Bonjour " + name + ",\n\nTon code de vérification PEASET Calculator est : " + issued.code + "\n\nIl est valable 15 minutes. Si tu n'as pas demandé ce code, ignore cet email.");
      if (!sent) {
        return new Response("Envoi d'email non configuré ou en échec", { status: 501, headers: corsHeaders() });
      }
      await env.CHAT_KV.put(accountKey(name), JSON.stringify({
        name: name, email: email, emailVerified: false, updatedAt: Date.now(),
      }));
      await registerTrader(env, name);
      return Response.json({ ok: true }, { headers: corsHeaders() });
    }

    if (url.pathname === "/email/verify" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return new Response("JSON invalide", { status: 400, headers: corsHeaders() });
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      const account = await readAccount(env, name);
      if (!account) return new Response("Compte introuvable", { status: 404, headers: corsHeaders() });
      const ok = await checkCode(env, name, "verify", body.code);
      if (!ok) return new Response("Code incorrect ou expiré", { status: 400, headers: corsHeaders() });
      account.emailVerified = true;
      const token = await issueToken(env, account);
      return Response.json({ ok: true, token: token }, { headers: corsHeaders() });
    }

    if (url.pathname === "/email/recover" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return new Response("JSON invalide", { status: 400, headers: corsHeaders() });
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      const account = await readAccount(env, name);
      if (account && account.emailVerified) {
        const issued = await issueCode(env, name, "recover");
        if (!issued.error) {
          await sendEmail(env, account.email,
            "PEASET Calculator — ton code de récupération",
            "Bonjour " + account.name + ",\n\nTon code de récupération PEASET Calculator est : " + issued.code + "\n\nIl est valable 15 minutes. Avec ce code, tu peux créer un nouveau mot de passe dans l'application. Si tu n'as pas demandé ce code, ignore cet email.");
        }
      }
      // Réponse toujours ok : on ne révèle pas si le compte existe.
      return Response.json({ ok: true }, { headers: corsHeaders() });
    }

    if (url.pathname === "/email/recover-verify" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return new Response("JSON invalide", { status: 400, headers: corsHeaders() });
      const name = String(body.name || "").trim().slice(0, MAX_NAME);
      const account = await readAccount(env, name);
      if (!account || !account.emailVerified) {
        return new Response("Compte introuvable", { status: 404, headers: corsHeaders() });
      }
      const ok = await checkCode(env, name, "recover", body.code);
      if (!ok) return new Response("Code incorrect ou expiré", { status: 400, headers: corsHeaders() });
      const token = await issueToken(env, account);
      return Response.json({ ok: true, token: token }, { headers: corsHeaders() });
    }

    // ---------- Comptes v2 : inscription, session, profil ----------
    if (url.pathname === "/account/register" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      if (!isValidEmail(email)) return jsonError(400, "Email invalide");
      if (password.length < 8) return jsonError(400, "Mot de passe trop court : 8 caractères minimum");
      const existing = await readEmailAccount(env, email);
      if (existing && existing.verified) {
        return jsonError(409, "Un compte existe déjà avec cet email. Connecte-toi.");
      }
      const issued = await issueCode(env, email, "account");
      if (issued.error === "wait") {
        return jsonError(429, "Attends une minute avant un nouveau code");
      }
      const sent = await sendEmail(env, email,
        "PEASET Calculator — ton code de vérification",
        "Bonjour,\n\nTon code de vérification PEASET Calculator est : " + issued.code + "\n\nIl est valable 15 minutes. Entre ce code dans l'application pour activer ton compte. Si tu n'as pas demandé ce code, ignore cet email.");
      if (!sent) {
        return jsonError(501, "Envoi d'email non configuré ou en échec");
      }
      if (existing && existing.tokenHash) {
        await env.CHAT_KV.delete("token:" + existing.tokenHash);
      }
      await writeEmailAccount(env, {
        email: email,
        pass: await hashPassword(password),
        verified: false,
        name: null,
        tokenHash: null,
        createdAt: Date.now(),
      });
      return jsonOk({ ok: true });
    }

    if (url.pathname === "/account/verify" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const email = normalizeEmail(body.email);
      const ok = await checkCode(env, email, "account", body.code);
      if (!ok) return jsonError(400, "Code incorrect ou expiré");
      const account = await readEmailAccount(env, email);
      if (!account) return jsonError(400, "Code incorrect ou expiré");
      if (account.blocked) return jsonError(403, "Compte bloqué par l'administrateur");
      account.verified = true;
      const token = await issueAccountToken(env, account);
      return jsonOk({ ok: true, token: token, name: account.name || null });
    }

    // Connexion / inscription avec Google : le site envoie le jeton
    // d'identité Google (bouton officiel « Continuer avec Google »). Le
    // moteur le vérifie chez Google (tokeninfo), contrôle l'audience (notre
    // ID client), l'émetteur et que l'email est vérifié par Google, puis
    // retrouve ou crée le compte v2 de cet email et émet la session habituelle.
    if (url.pathname === "/account/google" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const clientId = env.GOOGLE_CLIENT_ID || "";
      if (!clientId) return jsonError(503, "Connexion Google pas encore configurée");
      const idToken = String(body.idToken || body.credential || "");
      if (!idToken) return jsonError(400, "Jeton Google manquant");
      let info = null;
      try {
        const resp = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
        if (resp.ok) info = await resp.json();
      } catch (e) { info = null; }
      if (!info || info.aud !== clientId ||
          (info.iss !== "accounts.google.com" && info.iss !== "https://accounts.google.com") ||
          info.email_verified !== "true" || !isValidEmail(normalizeEmail(info.email))) {
        return jsonError(401, "Connexion Google refusée. Réessaie.");
      }
      const email = normalizeEmail(info.email);
      let account = await readEmailAccount(env, email);
      let created = false;
      if (!account) {
        account = {
          email: email,
          pass: await hashPassword(newToken() + ":" + newToken()),
          verified: true,
          name: null,
          tokenHash: null,
          createdAt: Date.now(),
          google: true,
          passSet: false,
        };
        created = true;
      }
      if (account.blocked) {
        return jsonError(403, "Compte bloqué par l'administrateur");
      }
      // Google a prouvé la propriété de l'email : le compte devient vérifié et lié à Google.
      account.verified = true;
      account.google = true;
      if (typeof account.passSet !== "boolean") account.passSet = true;
      const token = await issueAccountToken(env, account);
      return jsonOk({ ok: true, token: token, name: account.name || null, google: true, created: created });
    }

    if (url.pathname === "/account/login" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      const account = await readEmailAccount(env, email);
      if (account && account.google && account.passSet === false) {
        return jsonError(403, "Ce compte se connecte avec Google. Touche « Continuer avec Google ».");
      }
      if (!account || !(await verifyPassword(password, account.pass))) {
        return jsonError(401, "Email ou mot de passe incorrect");
      }
      if (!account.verified) {
        return jsonError(403, "Email non vérifié. Crée un nouveau compte pour recevoir un code.");
      }
      if (account.blocked) {
        return jsonError(403, "Compte bloqué par l'administrateur");
      }
      const token = await issueAccountToken(env, account);
      return jsonOk({ ok: true, token: token, name: account.name || null });
    }

    if (url.pathname === "/account/profile" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const account = await readAccountByToken(env, body.token);
      if (!account) return jsonError(401, "Session invalide. Reconnecte-toi.");
      const name = String(body.name || "").trim();
      if (name.length < 1 || name.length > MAX_NAME) {
        return jsonError(400, "Nom de trader invalide (1 à 40 caractères)");
      }
      const nameRec = await readAccount(env, name);
      if (nameRec && !nameRec.pass && nameRec.emailVerified && nameRec.email &&
          String(nameRec.email).toLowerCase() !== account.email) {
        return jsonError(409, "Ce nom de trader est déjà pris.");
      }
      account.name = name;
      await writeEmailAccount(env, account);
      await syncNameRecord(env, account);
      await registerTrader(env, name);
      return jsonOk({ ok: true, name: name });
    }

    if (url.pathname === "/account/recover" && request.method === "POST") {
      const body = await parseBody(request);
      if (body) {
        const email = normalizeEmail(body.email);
        const account = await readEmailAccount(env, email);
        if (account && account.verified) {
          const issued = await issueCode(env, email, "account-recover");
          if (!issued.error) {
            await sendEmail(env, email,
              "PEASET Calculator — ton code de récupération",
              "Bonjour,\n\nTon code de récupération PEASET Calculator est : " + issued.code + "\n\nIl est valable 15 minutes. Avec ce code, tu peux créer un nouveau mot de passe dans l'application. Si tu n'as pas demandé ce code, ignore cet email.");
          }
        }
      }
      // Réponse toujours ok : on ne révèle pas si le compte existe.
      return jsonOk({ ok: true });
    }

    if (url.pathname === "/account/recover-verify" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const email = normalizeEmail(body.email);
      const newPassword = String(body.newPassword || "");
      if (newPassword.length < 8) return jsonError(400, "Mot de passe trop court : 8 caractères minimum");
      const account = await readEmailAccount(env, email);
      if (!account || !account.verified) return jsonError(400, "Code incorrect ou expiré");
      if (account.blocked) return jsonError(403, "Compte bloqué par l'administrateur");
      const ok = await checkCode(env, email, "account-recover", body.code);
      if (!ok) return jsonError(400, "Code incorrect ou expiré");
      account.pass = await hashPassword(newPassword);
      account.passSet = true;
      const token = await issueAccountToken(env, account);
      return jsonOk({ ok: true, token: token, name: account.name || null });
    }

    if (url.pathname === "/account/password" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const account = await readAccountByToken(env, body.token);
      if (!account) return jsonError(401, "Session invalide. Reconnecte-toi.");
      const currentPassword = String(body.currentPassword || "");
      if (!(await verifyPassword(currentPassword, account.pass))) {
        return jsonError(401, "Mot de passe actuel incorrect");
      }
      const newPassword = String(body.newPassword || "");
      if (newPassword.length < 8) return jsonError(400, "Mot de passe trop court : 8 caractères minimum");
      account.pass = await hashPassword(newPassword);
      account.passSet = true;
      await writeEmailAccount(env, account);
      return jsonOk({ ok: true });
    }

    // ---------- Dons déclarés : déclaration publique ----------
    // Une déclaration n'est pas une preuve de paiement : le propriétaire
    // vérifie le don dans sa propre application MonCash/NatCash, puis confirme ici.
    if (url.pathname === "/donations" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      const name = String(body.name || "").trim();
      if (name.length < 1 || name.length > MAX_NAME) {
        return jsonError(400, "Nom manquant ou invalide (1 à 40 caractères)");
      }
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return jsonError(400, "Montant invalide : un nombre positif est requis (en gourdes)");
      }
      const method = String(body.method || "");
      if (method !== "MonCash" && method !== "NatCash") {
        return jsonError(400, "Méthode invalide : MonCash ou NatCash");
      }
      const code = String(body.code || "").trim();
      if (code.length < 4 || code.length > 60) {
        return jsonError(400, "Code de transaction invalide (4 à 60 caractères)");
      }
      const list = await readList(env, DONATIONS_KEY);
      list.push({
        id: newMessageId(),
        name: name,
        amount: amount,
        method: method,
        code: code,
        t: Date.now(),
        status: "attente",
      });
      while (list.length > MAX_DONATIONS) list.shift();
      await env.CHAT_KV.put(DONATIONS_KEY, JSON.stringify(list));
      return jsonOk({ ok: true });
    }

    // ---------- Dons déclarés : donateurs confirmés (badge public) ----------
    // Personnes (première casse rencontrée, dédupliquées sans tenir compte de
    // la casse) ayant au moins un don au statut "confirme" d'un montant d'au
    // moins BADGE_MIN_HTG gourdes. Lecture publique.
    // "donors" = objets { name, amount } où amount est le plus gros don
    // confirmé de la personne : le site choisit le badge selon ce montant
    // (500 bleu, 1000 violet, 2000 or, 5000 PRO). "levels" reprend les mêmes
    // montants par nom en minuscules.
    if (url.pathname === "/donors" && request.method === "GET") {
      const list = await readList(env, DONATIONS_KEY);
      const byKey = new Map();
      for (const d of list) {
        if (!d || d.status !== "confirme" || !d.name) continue;
        const amount = Number(d.amount);
        if (!(amount >= BADGE_MIN_HTG)) continue;
        const key = String(d.name).toLowerCase();
        const cur = byKey.get(key);
        if (!cur) byKey.set(key, { name: d.name, amount: amount });
        else if (amount > cur.amount) cur.amount = amount;
      }
      // L'administrateur (créateur du site) garde toujours son badge, même
      // après une mise à jour : plancher BADGE_MIN_HTG s'il n'a pas de don
      // confirmé au seuil. Un vrai don confirmé plus gros garde la main.
      const adminKey = adminName(env).toLowerCase();
      const adminCur = byKey.get(adminKey);
      if (!adminCur) byKey.set(adminKey, { name: adminName(env), amount: BADGE_MIN_HTG });
      else if (adminCur.amount < BADGE_MIN_HTG) adminCur.amount = BADGE_MIN_HTG;
      const donors = Array.from(byKey.values());
      const levels = {};
      for (const [key, v] of byKey) levels[key] = v.amount;
      return jsonOk({ donors: donors, levels: levels });
    }

    // ---------- Dons déclarés : liste (admin seulement) ----------
    if (url.pathname === "/donations/list" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      if (!(await isAdminRequest(env, body.token))) {
        return jsonError(403, "Réservé à l'administrateur");
      }
      const list = await readList(env, DONATIONS_KEY);
      return jsonOk({ donations: list.slice().reverse() });
    }

    // ---------- Dons déclarés : changer le statut (admin seulement) ----------
    if (url.pathname === "/donations/status" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      if (!(await isAdminRequest(env, body.token))) {
        return jsonError(403, "Réservé à l'administrateur");
      }
      const status = String(body.status || "");
      if (!DONATION_STATUSES.includes(status)) {
        return jsonError(400, "Statut invalide : confirme, rejete ou attente");
      }
      const list = await readList(env, DONATIONS_KEY);
      const don = list.find(d => d && d.id && d.id === String(body.id || ""));
      if (!don) return jsonError(404, "Don introuvable");
      don.status = status;
      await env.CHAT_KV.put(DONATIONS_KEY, JSON.stringify(list));
      return jsonOk({ ok: true });
    }

    // ---------- Panneau de contrôle : liste des comptes (admin seulement) ----------
    if (url.pathname === "/admin/accounts" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      if (!(await isAdminRequest(env, body.token))) {
        return jsonError(403, "Réservé à l'administrateur");
      }
      const accounts = await listEmailAccounts(env);
      const pub = accounts.map(publicAccount);
      pub.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return jsonOk({ accounts: pub.slice(0, 200), total: pub.length });
    }

    // ---------- Panneau de contrôle : bloquer / débloquer un compte (admin seulement) ----------
    if (url.pathname === "/admin/block" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      if (!(await isAdminRequest(env, body.token))) {
        return jsonError(403, "Réservé à l'administrateur");
      }
      const email = normalizeEmail(body.email);
      const target = await readEmailAccount(env, email);
      if (!target) return jsonError(404, "Compte introuvable");
      if (target.name && isAdminName(env, target.name)) {
        return jsonError(400, "Le compte administrateur ne peut pas être bloqué");
      }
      target.blocked = !!body.blocked;
      if (target.blocked && target.tokenHash) {
        // Blocage immédiat : la session en cours est révoquée des deux côtés.
        await env.CHAT_KV.delete("token:" + target.tokenHash);
        target.tokenHash = null;
        if (target.name) {
          const nameRec = await readAccount(env, target.name);
          if (nameRec && !nameRec.pass) {
            nameRec.tokenHash = null;
            await env.CHAT_KV.put(accountKey(target.name), JSON.stringify(nameRec));
          }
        }
      }
      await writeEmailAccount(env, target);
      return jsonOk({ ok: true, account: publicAccount(target) });
    }

    // ---------- Panneau de contrôle : activité de la communauté (admin seulement) ----------
    if (url.pathname === "/admin/activity" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) return jsonError(400, "JSON invalide");
      if (!(await isAdminRequest(env, body.token))) {
        return jsonError(403, "Réservé à l'administrateur");
      }
      const accounts = await listEmailAccounts(env);
      const messages = await readList(env, MESSAGES_KEY);
      const reviews = await readList(env, REVIEWS_KEY);
      const donations = await readList(env, DONATIONS_KEY);
      const index = await readList(env, PRESENCE_INDEX_KEY);
      const now = Date.now();
      const online = [];
      const seenOnline = new Set();
      for (const e of index) {
        if (!e || !e.name || !e.nameLower) continue;
        if (now - (e.ts || 0) > PRESENCE_WINDOW_MS) continue;
        if (seenOnline.has(e.nameLower)) continue;
        seenOnline.add(e.nameLower);
        online.push(e.name);
      }
      let donAttente = 0, donConfirme = 0, donRejete = 0, totalConfirme = 0;
      for (const d of donations) {
        if (!d) continue;
        if (d.status === "confirme") { donConfirme++; totalConfirme += Number(d.amount) || 0; }
        else if (d.status === "rejete") donRejete++;
        else donAttente++;
      }
      const lastMessages = messages.slice(-8).reverse().map(m => ({
        name: m.name || "", text: String(m.text || "").slice(0, 120), t: m.t || null,
      }));
      const lastReviews = reviews.slice(-8).reverse().map(r => ({
        name: r.name || "", stars: r.stars || null, text: String(r.text || "").slice(0, 120), t: r.t || null,
      }));
      return jsonOk({
        accountsTotal: accounts.length,
        accountsBlocked: accounts.filter(a => a.blocked).length,
        messagesTotal: messages.length,
        reviewsTotal: reviews.length,
        online: online,
        donations: { attente: donAttente, confirme: donConfirme, rejete: donRejete, totalConfirme: totalConfirme },
        lastMessages: lastMessages,
        lastReviews: lastReviews,
      });
    }

    return new Response("PEASET — moteur communautaire (discussion + avis + prive + email)", { headers: corsHeaders() });
    } catch (e) {
      return jsonError(503, "Service momentanément indisponible, réessaie.");
    }
  },
};
