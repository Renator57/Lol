// Riot-API-Proxy für das Draft Board (Cloudflare Worker)
// Hält den Riot-API-Key geheim und fasst die letzten Spiele eines Spielers zusammen.
//
//   GET /?id=Name%23TAG&region=euw&queue=ranked&count=20[&season=1]   season=1: nur Spiele seit Saisonstart (1. Januar)
//   GET /health
//   GET /live?ids=Name%23TAG,Name2%23TAG&region=euw   laufendes Spiel (Spectator-V5) des ersten Spielers, der gerade spielt
//   GET /pl?url=https://www.primeleague.gg/…   Riot-IDs von einer Prime-League-Teamseite
//   GET /patch?v=26.20&lang=de-de   offizielle Patchnotes (leagueoflegends.com erlaubt kein CORS)
//   /vod/...  Video-Upload für die VOD-Review (optional, braucht R2, siehe README.md)
//
// Secrets / Variablen (siehe README.md):
//   RIOT_API_KEY     – Pflicht, per `wrangler secret put RIOT_API_KEY`
//   ALLOWED_ORIGINS  – empfohlen, kommagetrennt, z. B. "https://name.github.io" (Standard: alle)
//   VODS             – optional, R2-Bucket-Bindung für hochgeladene Videos
//   UPLOAD_KEY       – optional, Upload-Passwort (Geheimnis); ohne es ist Hochladen gesperrt
//
// Ausgelegt auf einen Personal API Key (20 Aufrufe/s, 100 Aufrufe/2 Min.):
// Match-Details werden 30 Tage gecacht, neue Spiele nur geladen, solange das
// Budget reicht. Der Rest kommt als "partial" + "retryIn" zurück und das Board
// lädt ihn automatisch nach.

const REGIONS = {
  euw:  { platform: "euw1", regional: "europe" },
  eune: { platform: "eun1", regional: "europe" },
  tr:   { platform: "tr1",  regional: "europe" },
  na:   { platform: "na1",  regional: "americas" },
  kr:   { platform: "kr",   regional: "asia" },
};
// queue-Filter → Query für match-v5
const QUEUES = {
  ranked:     "type=ranked",   // Solo/Duo + Flex
  solo:       "queue=420",
  flex:       "queue=440",
  tournament: "type=tournament", // Turnier-Codes (z. B. Prime League)
  all:        "",
};
const VERSION = 13;          // vom Board geprüft (Einstellungen → Testen)
const MAX_COUNT = 100;         // „Saison“ im Board: bis 100 Spiele seit Saisonstart
// Cloudflare-eigener Standard-Cache (caches.default fehlt in den Browser-Typen)
const edgeCache = () => /** @type {Cache} */ (/** @type {any} */ (caches).default);
const CACHE_RESULT = 600;      // fertige Antwort: 10 Min.
const CACHE_ACCOUNT = 2592000; // Riot-ID → PUUID: 30 Tage (PUUID ändert sich nie)
const CACHE_IDS = 300;         // Liste der letzten Spiele: 5 Min.
const CACHE_LEAGUE = 1800;     // Rang: 30 Min.
const CACHE_MATCH = 2592000;
const CACHE_MASTERY = 21600;   // Champion-Mastery: 6 Std.
// Cloudflare (Gratis-Tarif) erlaubt höchstens 50 Unteranfragen pro Aufruf → neue Spiele pro Aufruf begrenzen,
// den Rest lädt das Board automatisch nach
const MAX_NEW = 30;
const STORE_MAX = 300;        // gemerkte Spiele pro Spieler   // Match-Details ändern sich nie: 30 Tage

export default {
  async fetch(req, env, ctx) {
    // Key beim Einfügen oft mit Leerzeichen, Zeilenumbruch oder Anführungszeichen kopiert → bereinigen
    if (env.RIOT_API_KEY) env = { ...env, RIOT_API_KEY: String(env.RIOT_API_KEY).trim().replace(/^["']|["']$/g, "").trim() };
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    // Videos abspielen: <video> schickt keinen Origin-Header → ohne Origin-Prüfung, Datei-Namen sind zufällig
    if (url.pathname.startsWith("/vod/f/") && (req.method === "GET" || req.method === "HEAD")) return vodGet(req, env, url, cors);
    if (!cors["Access-Control-Allow-Origin"]) return json({ error: "Origin nicht erlaubt." }, 403, cors);
    if (url.pathname.startsWith("/vod/")) return vodApi(req, env, url, cors);
    if (req.method !== "GET") return json({ error: "Nur GET erlaubt." }, 405, cors);

    if (url.pathname === "/health") return json({ ok: true, key: !!env.RIOT_API_KEY, keyOk: /^RGAPI-[0-9a-f-]{36}$/i.test(env.RIOT_API_KEY || ""), version: VERSION, vod: !!env.VODS, vodAuth: !!env.UPLOAD_KEY }, 200, { ...cors, "Cache-Control": "no-store" });
    if (url.pathname === "/patch") return patchNotes(url, ctx, cors); // braucht keinen API-Key
    if (url.pathname === "/pl") return primeTeam(url, ctx, cors);
    if (!env.RIOT_API_KEY) return json({ error: "RIOT_API_KEY fehlt im Worker." }, 500, cors);

    if (url.pathname === "/live") return liveGame(url, env, ctx, cors);

    // unsichtbare Steuerzeichen (aus dem LoL-Client kopiert) entfernen, sonst antwortet Riot mit 400
    const id = (url.searchParams.get("id") || "").normalize("NFC").replace(/[\p{Cf}\p{Cc}]/gu, "").replace(/\s+/g, " ").trim();
    const region = (url.searchParams.get("region") || "euw").toLowerCase();
    const queue = (url.searchParams.get("queue") || "ranked").toLowerCase();
    const count = Math.min(MAX_COUNT, Math.max(1, parseInt(url.searchParams.get("count") || "20", 10) || 20));
    const season = url.searchParams.get("season") === "1";
    const seasonStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);
    const reg = REGIONS[region];
    if (!reg) return json({ error: "Unbekannte Region." }, 400, cors);
    if (!(queue in QUEUES)) return json({ error: "Unbekannter Queue-Filter." }, 400, cors);
    const hash = id.lastIndexOf("#");
    const name = (hash > 0 ? id.slice(0, hash) : id).trim();
    const tag = (hash > 0 ? id.slice(hash + 1) : region.toUpperCase()).trim();
    if (!name || name.length > 32 || !tag || tag.length > 8) return json({ error: "Ungültige Riot-ID (Name#TAG)." }, 400, cors);

    // fertige Antwort aus dem Cache?
    // PUUIDs sind je API-Key verschlüsselt: Cache deshalb pro Key trennen (sonst 400 nach Key-Wechsel)
    const kt = await keyTag(env.RIOT_API_KEY);
    const cacheKey = new Request(`https://cache.local/v5/${kt}/${region}/${queue}/${count}${season ? "s" : ""}/${encodeURIComponent(name.toLowerCase() + "#" + tag.toLowerCase())}`);
    const hit = await edgeCache().match(cacheKey);
    if (hit) return withCors(hit, cors);

    const riot = makeRiot(env, ctx, kt);
    const api = host => `https://${host}.api.riotgames.com`;
    try {
      const accUrl = `${api(reg.regional)}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
      let acc = await riot(accUrl, CACHE_ACCOUNT, "Konto");
      const q = QUEUES[queue];
      const load = a => Promise.all([
        riot(`${api(reg.regional)}/lol/match/v5/matches/by-puuid/${a.puuid}/ids?start=0&count=${count}${q ? "&" + q : ""}${season ? "&startTime=" + seasonStart : ""}`, CACHE_IDS, "Spieleliste"),
        riot(`${api(reg.platform)}/lol/league/v4/entries/by-puuid/${a.puuid}`, CACHE_LEAGUE, "Rang").catch(() => []),
        riot(`${api(reg.platform)}/lol/champion-mastery/v4/champion-masteries/by-puuid/${a.puuid}/top?count=10`, CACHE_MASTERY, "Mastery").catch(() => []),
      ]);
      let ids, leagues, mastery;
      try { [ids, leagues, mastery] = await load(acc); }
      catch (e) {
        // veraltete PUUID im Cache? Konto einmal frisch abfragen und erneut versuchen
        if (e.status !== 400 && e.status !== 404 && e.status !== 403) throw e;
        acc = await riot(accUrl, CACHE_ACCOUNT, "Konto", true);
        [ids, leagues, mastery] = await load(acc);
      }
      const puuid = acc.puuid;
      // Pro Spieler EIN Cache-Eintrag mit den kompakten Zeilen aller schon geladenen Spiele
      // (statt je Spiel ~50 KB einzeln) – spart Unteranfragen und CPU
      const storeReq = new Request(`https://cache.local/pm2/${kt}/${puuid}`);
      let store = {};
      try { const c = await edgeCache().match(storeReq); if (c) store = await c.json(); } catch (e) { store = {}; }
      const missing = ids.filter(mid => !(mid in store));
      const n = Math.min(missing.length, budgetLeft(reg.regional), MAX_NEW);
      let added = 0;
      await pool(missing.slice(0, n), 4, async mid => {
        if (budgetLeft(reg.regional) <= 0) return; // Budget unterwegs aufgebraucht
        const m = await riot(`${api(reg.regional)}/lol/match/v5/matches/${mid}`, 0, "Match").catch(() => null);
        if (!m) return;
        const info = m.info || {}, p = (info.participants || []).find(x => x.puuid === puuid);
        store[mid] = p ? [mid, p.championName, p.win ? 1 : 0, p.teamPosition || p.individualPosition || "", p.kills, p.deaths, p.assists, info.gameStartTimestamp || info.gameCreation || 0, info.gameDuration || 0, info.queueId || 0, teamDraft(info, p)] : 0;
        added++;
      });
      if (added) {
        const keep = Object.entries(store).sort((x, y) => (y[1] ? y[1][7] : 0) - (x[1] ? x[1][7] : 0)).slice(0, STORE_MAX);
        ctx.waitUntil(edgeCache().put(storeReq, new Response(JSON.stringify(Object.fromEntries(keep)), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_MATCH}` } })));
      }
      const rows = ids.map(mid => store[mid]).filter(Boolean);
      const loadedN = ids.filter(mid => mid in store).length;
      const partial = loadedN < ids.length;
      const result = summarize(acc, rows, leagues, { region, queue, requested: ids.length });
      // Mastery: [Champion-Key, Punkte, Stufe, zuletzt gespielt]
      result.mastery = (Array.isArray(mastery) ? mastery : []).map(m => [m.championId, m.championPoints, m.championLevel, m.lastPlayTime]);
      result.season = season;
      result.partial = partial;
      result.loaded = loadedN;
      result.requested = ids.length;
      if (partial) result.retryIn = budgetLeft(reg.regional) > 0 ? 2 : retryEstimate(reg.regional); // nur Häppchen-Grenze → gleich weiter
      const res = json(result, 200, partial ? { "Cache-Control": "no-store" } : { "Cache-Control": `public, max-age=${CACHE_RESULT}` });
      if (!partial) ctx.waitUntil(edgeCache().put(cacheKey, res.clone()));
      return withCors(res, cors);
    } catch (e) {
      const status = e.status || 502;
      const detail = e.step ? ` (${e.step}${e.msg ? ": " + e.msg : ""})` : "";
      const msg = status === 404 ? "Riot-ID nicht gefunden." + (e.step && e.step !== "Konto" ? detail : "")
        : status === 400 && e.step === "Konto" ? "Ungültige Riot-ID – Schreibweise Name#TAG prüfen." + detail
        : status === 400 ? "Riot lehnt die Anfrage ab" + detail + "."
        : status === 429 ? "Riot-Limit erreicht."
        : status === 401 || status === 403 ? "API-Key ungültig oder abgelaufen."
        : e.status ? "Riot-API nicht erreichbar." : "Worker-Fehler: " + String(e && e.message || e).slice(0, 120);
      const retryAfter = status === 429 ? (e.retryAfter || retryEstimate(reg.regional)) : 0;
      return json({ error: msg, status, ...(retryAfter ? { retryAfter } : {}) }, status === 404 || status === 400 ? status : status === 429 ? 429 : 502, { ...cors, ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) });
    }
  },
};

// ---------- Rate-Limit (Personal Key: 20/1 s und 100/2 Min., je Routing-Host) ----------
// Riot meldet den Verbrauch in jedem Antwort-Header (X-App-Rate-Limit-Count: "3:1,47:120").
// Der Stand gilt pro Worker-Instanz; als Puffer bleiben immer ein paar Aufrufe frei.
const RESERVE = 4;          // Aufrufe, die im 2-Minuten-Fenster frei bleiben
const MIN_GAP_MS = 70;      // ≈ 14 Aufrufe/Sekunde, sicher unter 20/s
const hosts = {};           // host → { lastStart, used, max, window, seenAt }
const hostOf = u => new URL(u).hostname.split(".")[0];
function hostState(h) { return hosts[h] || (hosts[h] = { lastStart: 0, used: 0, max: 100, window: 120, seenAt: 0 }); }
function readLimits(h, r) {
  const lim = parsePairs(r.headers.get("X-App-Rate-Limit")), cnt = parsePairs(r.headers.get("X-App-Rate-Limit-Count"));
  const win = Math.max(0, ...Object.keys(lim).map(Number));
  if (!win) return;
  const s = hostState(h);
  s.window = win; s.max = lim[win]; s.used = cnt[win] || 0; s.seenAt = Date.now();
}
const parsePairs = v => Object.fromEntries(String(v || "").split(",").filter(Boolean).map(p => { const [n, w] = p.split(":").map(Number); return [w, n]; }));
function budgetLeft(h) {
  const s = hostState(h);
  if (!s.seenAt || Date.now() - s.seenAt > s.window * 1000) return Infinity; // Fenster sicher abgelaufen
  return Math.max(0, s.max - s.used - RESERVE);
}
// Riot verrät nicht, wann das Fenster neu startet: nach einem Viertel-Fenster erneut probieren
const retryEstimate = h => Math.ceil(hostState(h).window / 4);
async function throttle(h) {
  const s = hostState(h);
  const wait = s.lastStart + MIN_GAP_MS - Date.now();
  s.lastStart = Math.max(Date.now(), s.lastStart + MIN_GAP_MS);
  if (wait > 0) await sleep(wait);
}

const ck = (u, kt) => new Request(u + (u.includes("?") ? "&" : "?") + "__k=" + kt); // Cache-Eintrag je API-Key
async function keyTag(key) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(key)));
  return [...new Uint8Array(b)].slice(0, 6).map(x => x.toString(16).padStart(2, "0")).join("");
}
async function cached(u, kt) {
  const c = await edgeCache().match(ck(u, kt));
  return c ? c.json() : null;
}

function makeRiot(env, ctx, kt) {
  return async function riot(u, ttl, step = "", fresh = false) {
    if (ttl && !fresh) { const c = await cached(u, kt); if (c) return c; }
    const h = hostOf(u);
    for (let attempt = 0; ; attempt++) {
      await throttle(h);
      const r = await fetch(u, { headers: { "X-Riot-Token": env.RIOT_API_KEY } });
      readLimits(h, r);
      if (r.ok) {
        const body = await r.text();
        if (ttl) ctx.waitUntil(edgeCache().put(ck(u, kt), new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } })));
        return JSON.parse(body);
      }
      const retryAfter = parseInt(r.headers.get("Retry-After") || "0", 10);
      if (r.status === 429) { const s = hostState(h); s.used = s.max; s.seenAt = Date.now(); }
      if (r.status === 429 && attempt === 0 && retryAfter > 0 && retryAfter <= 2) { await sleep(retryAfter * 1000); continue; }
      if (r.status >= 500 && attempt === 0) { await sleep(500); continue; }
      let msg = ""; try { msg = String((JSON.parse(await r.text()).status || {}).message || "").slice(0, 120); } catch (e) {}
      throw new RiotError(r.status, retryAfter, step, msg);
    }
  };
}

class RiotError extends Error {
  /** @param {number} status @param {number} retryAfter @param {string} [step] @param {string} [msg] */
  constructor(status, retryAfter, step = "", msg = "") {
    super("riot " + status);
    this.status = status;
    this.retryAfter = retryAfter;
    this.step = step;
    this.msg = msg;
  }
}

// rows: [Match-ID, Champion, Sieg, Position, K, D, A, Start, Dauer (s), Queue] – neueste zuerst
function summarize(acc, rows, leagues, meta) {
  const champs = {}, positions = {};
  let games = 0, wins = 0, k = 0, d = 0, a = 0;
  const recent = [], list = [];
  for (const r of rows) {
    const [mid, champ, win, pos0, kk, dd, aa, start, dur, queueId] = r;
    if (dur && dur < 300) continue; // Remakes ignorieren
    const pos = pos0 && pos0 !== "Invalid" ? pos0 : "";
    games++; if (win) wins++;
    k += kk; d += dd; a += aa;
    if (pos) positions[pos] = (positions[pos] || 0) + 1;
    const c = champs[champ] || (champs[champ] = { id: champ, games: 0, wins: 0, k: 0, d: 0, a: 0, pos: {} });
    c.games++; if (win) c.wins++;
    c.k += kk; c.d += dd; c.a += aa;
    if (pos) c.pos[pos] = (c.pos[pos] || 0) + 1;
    // kompakte Spieleliste: erkennt im Board gemeinsame Spiele (Duos)
    list.push(r[10] ? [mid, champ, win ? 1 : 0, pos, kk, dd, aa, start, dur, queueId, r[10]] : [mid, champ, win ? 1 : 0, pos, kk, dd, aa, start, dur, queueId]);
    if (recent.length < 10) recent.push({ champ, win: !!win, k: kk, d: dd, a: aa, pos, queue: queueId, at: start, dur });
  }
  return {
    riotId: `${acc.gameName}#${acc.tagLine}`,
    region: meta.region, queue: meta.queue,
    fetchedAt: Date.now(),
    games, wins,
    kda: { k, d, a },
    positions,
    champs: Object.values(champs).sort((a, b) => b.games - a.games || b.wins - a.wins),
    rank: (Array.isArray(leagues) ? leagues : []).map(l => ({ queue: l.queueType, tier: l.tier, rank: l.rank, lp: l.leaguePoints, wins: l.wins, losses: l.losses })),
    recent,
    matches: list,
  };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : "";
  return ok ? { "Access-Control-Allow-Origin": ok, "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Upload-Key, Range", "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges", "Access-Control-Max-Age": "86400", "Vary": "Origin" } : {};
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
function withCors(res, cors) { const r = new Response(res.body, res); Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v)); return r; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- VOD-Upload (Cloudflare R2) ----------
// Große Dateien kommen in Teilen (Multipart, je ≤ 50 MB) – so bleibt jede Anfrage unter dem Worker-Limit.
const VOD_PART_MAX = 52 * 1024 * 1024;
const VOD_TYPES = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv" };
const vodKeyOk = k => /^v\/[a-z0-9]{20}\.(mp4|webm|mov|mkv)$/.test(k || "");
function vodAuthed(req, env) {
  const a = req.headers.get("X-Upload-Key") || "", b = env.UPLOAD_KEY || "";
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function vodApi(req, env, url, cors) {
  if (!env.VODS) return json({ error: "Kein R2-Bucket verbunden (Bindung VODS fehlt)." }, 501, cors);
  if (!env.UPLOAD_KEY) return json({ error: "UPLOAD_KEY fehlt im Worker." }, 501, cors);
  if (!vodAuthed(req, env)) return json({ error: "Upload-Passwort falsch." }, 401, cors);
  const p = url.pathname, q = url.searchParams;
  try {
    if (p === "/vod/check" && req.method === "GET") return json({ ok: true }, 200, cors);
    if (p === "/vod/usage" && req.method === "GET") {
      let bytes = 0, files = 0, cursor;
      do { const l = await env.VODS.list({ prefix: "v/", cursor }); for (const o of l.objects) { bytes += o.size; files++; } cursor = l.truncated ? l.cursor : undefined; } while (cursor);
      return json({ bytes, files }, 200, cors);
    }
    if (p === "/vod/list" && req.method === "GET") {
      const files = []; let cursor;
      do { const l = await env.VODS.list({ prefix: "v/", cursor, include: ["customMetadata"] }); for (const o of l.objects) files.push({ key: o.key, size: o.size, at: o.uploaded ? new Date(o.uploaded).getTime() : 0, name: (o.customMetadata || {}).name || "" }); cursor = l.truncated ? l.cursor : undefined; } while (cursor);
      return json({ files: files.sort((a, b) => a.at - b.at), url: `${url.origin}/vod/f/` }, 200, cors);
    }
    if (p === "/vod/create" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const ext = VOD_TYPES[b.type] || (/\.(mp4|webm|mov|mkv)$/i.exec(b.name || "") || [])[1]?.toLowerCase();
      if (!ext) return json({ error: "Nur MP4, WebM, MOV oder MKV." }, 400, cors);
      const id = [...crypto.getRandomValues(new Uint8Array(20))].map(x => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("");
      const key = `v/${id}.${ext}`;
      const mpu = await env.VODS.createMultipartUpload(key, { httpMetadata: { contentType: b.type || "video/" + ext }, customMetadata: { name: String(b.name || "").slice(0, 200) } });
      return json({ key, uploadId: mpu.uploadId }, 200, cors);
    }
    const key = q.get("key"), uploadId = q.get("uploadId");
    if (p === "/vod/part" && req.method === "PUT") {
      const n = parseInt(q.get("part") || "", 10);
      if (!vodKeyOk(key) || !uploadId || !(n >= 1 && n <= 10000)) return json({ error: "Ungültiger Teil." }, 400, cors);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > VOD_PART_MAX) return json({ error: "Teil zu groß." }, 413, cors);
      const part = await env.VODS.resumeMultipartUpload(key, uploadId).uploadPart(n, buf);
      return json(part, 200, cors);
    }
    if (p === "/vod/complete" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (!vodKeyOk(b.key) || !b.uploadId || !Array.isArray(b.parts)) return json({ error: "Ungültig." }, 400, cors);
      await env.VODS.resumeMultipartUpload(b.key, b.uploadId).complete(b.parts.map(x => ({ partNumber: +x.partNumber, etag: String(x.etag) })));
      return json({ url: `${url.origin}/vod/f/${b.key}` }, 200, cors);
    }
    if (p === "/vod/abort" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (vodKeyOk(b.key) && b.uploadId) await env.VODS.resumeMultipartUpload(b.key, b.uploadId).abort().catch(() => {});
      return json({ ok: true }, 200, cors);
    }
    if (p.startsWith("/vod/f/") && req.method === "DELETE") {
      const k = p.slice(7); if (!vodKeyOk(k)) return json({ error: "Ungültig." }, 400, cors);
      await env.VODS.delete(k); return json({ ok: true }, 200, cors);
    }
    return json({ error: "Unbekannt." }, 404, cors);
  } catch (e) {
    return json({ error: "R2: " + (e && e.message || e) }, 500, cors);
  }
}
// Abspielen mit Range-Unterstützung (Spulen im Video)
async function vodGet(req, env, url, cors) {
  const h = { "Access-Control-Allow-Origin": cors["Access-Control-Allow-Origin"] || "*", "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges" };
  if (!env.VODS) return new Response("Kein Video-Speicher.", { status: 501, headers: h });
  const key = url.pathname.slice(7); if (!vodKeyOk(key)) return new Response("Nicht gefunden.", { status: 404, headers: h });
  const range = req.headers.get("Range");
  const obj = await env.VODS.get(key, range ? { range: req.headers } : {});
  if (!obj) return new Response("Nicht gefunden.", { status: 404, headers: h });
  const headers = new Headers(h);
  obj.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes"); headers.set("ETag", obj.httpEtag); headers.set("Cache-Control", "public, max-age=31536000, immutable");
  const r = /** @type {any} */ (obj).range;
  if (range && r) {
    const start = r.offset ?? (r.suffix != null ? obj.size - r.suffix : 0);
    const len = r.length ?? (r.suffix != null ? r.suffix : obj.size - start);
    headers.set("Content-Range", `bytes ${start}-${start + len - 1}/${obj.size}`); headers.set("Content-Length", String(len));
    return new Response(req.method === "HEAD" ? null : obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(req.method === "HEAD" ? null : obj.body, { status: 200, headers });
}

// ---------- Laufendes Spiel (Spectator-V5) ----------
// Prüft die Riot-IDs der Reihe nach (Konten sind 30 Tage gecacht) und liefert das erste laufende Spiel.
const cleanId = v => String(v || "").normalize("NFC").replace(/[\p{Cf}\p{Cc}]/gu, "").replace(/\s+/g, " ").trim();
async function liveGame(url, env, ctx, cors) {
  const region = (url.searchParams.get("region") || "euw").toLowerCase(), reg = REGIONS[region];
  if (!reg) return json({ error: "Unbekannte Region." }, 400, cors);
  const ids = (url.searchParams.get("ids") || url.searchParams.get("id") || "").split(",").map(cleanId).filter(Boolean).slice(0, 10);
  if (!ids.length) return json({ error: "Keine Riot-IDs angegeben." }, 400, cors);
  const kt = await keyTag(env.RIOT_API_KEY), riot = makeRiot(env, ctx, kt);
  const api = host => `https://${host}.api.riotgames.com`;
  const checked = [];
  try {
    for (const id of ids) {
      const h = id.lastIndexOf("#"), name = (h > 0 ? id.slice(0, h) : id).trim(), tag = (h > 0 ? id.slice(h + 1) : region.toUpperCase()).trim();
      if (!name || !tag) continue;
      const accUrl = `${api(reg.regional)}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
      let acc;
      try { acc = await riot(accUrl, CACHE_ACCOUNT, "Konto"); }
      catch (e) { if (e.status === 404 || e.status === 400) { checked.push({ id, err: "nicht gefunden" }); continue; } throw e; }
      const spec = a => riot(`${api(reg.platform)}/lol/spectator/v5/active-games/by-summoner/${a.puuid}`, 15, "Live-Spiel");
      let g = null;
      try { g = await spec(acc); }
      catch (e) {
        if (e.status === 404) { checked.push({ id, live: false }); continue; }
        if (e.status !== 400 && e.status !== 403) throw e;
        // veraltete PUUID (anderer Key) → Konto frisch holen, einmal neu versuchen
        acc = await riot(accUrl, CACHE_ACCOUNT, "Konto", true);
        try { g = await spec(acc); } catch (e2) { if (e2.status === 404) { checked.push({ id, live: false }); continue; } throw e2; }
      }
      // nur Summoner's Rift (Ranked, Normal, Flex, Clash, Turnier, Custom) – ARAM, Arena, URF usw. überspringen
      if (g.gameMode !== "CLASSIC" || (g.mapId && g.mapId !== 11)) { checked.push({ id, live: true, mode: g.gameMode || "", queue: g.gameQueueConfigId || 0 }); continue; }
      const me = (g.participants || []).find(p => p.puuid === acc.puuid);
      return json({
        live: true, foundBy: `${acc.gameName}#${acc.tagLine}`, myTeam: me ? me.teamId : 100,
        gameId: g.gameId, queue: g.gameQueueConfigId || 0, mode: g.gameMode || "", type: g.gameType || "",
        start: g.gameStartTime || 0, length: g.gameLength || 0,
        players: (g.participants || []).map(p => ({ team: p.teamId, champ: p.championId, riotId: p.riotId || "", s1: p.spell1Id, s2: p.spell2Id })),
        bans: (g.bannedChampions || []).filter(b => b.championId > 0).map(b => ({ champ: b.championId, team: b.teamId, turn: b.pickTurn })),
        checked,
      }, 200, { ...cors, "Cache-Control": "no-store" });
    }
    return json({ live: false, checked }, 200, { ...cors, "Cache-Control": "no-store" });
  } catch (e) {
    const status = e.status || 502;
    const msg = status === 429 ? "Riot-Limit erreicht." : status === 401 ? "API-Key ungültig oder abgelaufen."
      : status === 403 ? `Riot verweigert den Zugriff${e.step ? " (" + e.step + ")" : ""} – Key abgelaufen oder für diese Schnittstelle nicht freigeschaltet.`
      : `Riot-Fehler ${status}${e.step ? " bei " + e.step : ""}${e.msg ? ": " + e.msg : ""}.`;
    return json({ error: msg, status, step: e.step || "", checked, ...(status === 429 ? { retryAfter: e.retryAfter || 10 } : {}) }, status === 429 ? 429 : 502, cors);
  }
}

// ---------- Offizielle Patchnotes ----------
// Holt die Patchnotes-Seite von leagueoflegends.com und gibt nur den Artikel-Inhalt (HTML) zurück.
// Das Board baut daraus eigene Karten – das HTML wird dort nie direkt eingefügt.
const PATCH_LANGS = ["de-de", "en-gb", "en-us"];
async function patchNotes(url, ctx, cors) {
  const m = String(url.searchParams.get("v") || "").match(/^(\d{2})\.(\d{1,2})$/);
  if (!m) return json({ error: "Ungültiger Patch (z. B. 26.20)." }, 400, cors);
  const lang = PATCH_LANGS.includes(url.searchParams.get("lang") || "") ? url.searchParams.get("lang") : "de-de";
  const v = m[1] + "." + (+m[2]);
  const cacheKey = new Request(`https://patch.cache/${lang}/${v}`);
  const hit = await edgeCache().match(cacheKey);
  if (hit) return withCors(hit, cors);
  const slugs = [...new Set([`patch-${m[1]}-${+m[2]}-notes`, `patch-${m[1]}-${m[2].padStart(2, "0")}-notes`, `league-of-legends-patch-${m[1]}-${+m[2]}-notes`])];
  let page = "", src = "";
  outer: for (const l of [...new Set([lang, "en-us"])]) for (const slug of slugs) {
    const u = `https://www.leagueoflegends.com/${l}/news/game-updates/${slug}/`;
    try {
      const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (DraftBoard Patchnotes)", "Accept-Language": l }, cf: { cacheTtl: 1800 } });
      if (r.ok) { page = await r.text(); src = u; break outer; }
    } catch (e) { /* nächste Variante */ }
  }
  if (!page) return json({ error: "Patchnotes für " + v + " noch nicht veröffentlicht.", status: 404 }, 404, { ...cors, "Cache-Control": "max-age=600" });
  const html = patchArticle(page);
  if (!html) return json({ error: "Patchnotes-Seite hat ein unbekanntes Format.", url: src }, 502, cors);
  const res = json({ v, lang: src.split("/")[3], url: src, html }, 200, { "Cache-Control": "public, max-age=21600" });
  ctx.waitUntil(edgeCache().put(cacheKey, res.clone()));
  return withCors(res, cors);
}
function patchArticle(page) {
  const strip = h => h.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<svg[\s\S]*?<\/svg>/gi, "");
  // Neue Seite (Next.js): der Artikel steckt als HTML-Text in __NEXT_DATA__
  const nd = page.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) {
    try {
      const parts = [], seen = new Set();
      const walk = x => {
        if (typeof x === "string") { if (x.length > 200 && /<(h2|h3|h4|ul|li|p)[\s>]/.test(x) && !seen.has(x)) { seen.add(x); parts.push(x); } }
        else if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") Object.values(x).forEach(walk);
      };
      walk(JSON.parse(nd[1]));
      const body = parts.join("\n");
      if (/<h[234][\s>]/.test(body)) return strip(body);
    } catch (e) { /* weiter mit dem HTML */ }
  }
  // Ältere Seite: fertiges HTML im Container
  const i = page.search(/<div[^>]+id="patch-notes-container"/);
  if (i >= 0) return strip(page.slice(i, i + 1500000));
  const b = page.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const all = strip(b ? b[1] : page);
  return /patch-change-block|change-title/.test(all) ? all : "";
}

// ---------- Team-Draft eines Spiels (nur Summoner's Rift außerhalb von Solo/Duo – dort spielen 5er-Teams) ----------
// [Seite 100/200, eigene Champions (Top→Sup), eigene Banns (Champion-Keys), gegnerische Champions, gegnerische Banns, Riot-IDs des eigenen Teams]
const POS_ORDER = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
function teamDraft(info, p) {
  if (info.mapId !== 11 || info.queueId === 420) return undefined;
  const all = info.participants || [];
  const sort = list => { const out = POS_ORDER.map(pos => list.find(x => (x.teamPosition || x.individualPosition) === pos)); const rest = list.filter(x => !out.includes(x)); return out.map(x => x || rest.shift()).filter(Boolean); };
  const mine = sort(all.filter(x => x.teamId === p.teamId)), foe = sort(all.filter(x => x.teamId !== p.teamId));
  const bans = id => ((info.teams || []).find(t => t.teamId === id) || {}).bans || [];
  const ban = id => bans(id).slice().sort((a, b) => a.pickTurn - b.pickTurn).map(b => b.championId).filter(c => c > 0);
  const foeId = p.teamId === 100 ? 200 : 100;
  return [p.teamId, mine.map(x => x.championName), ban(p.teamId), foe.map(x => x.championName), ban(foeId), mine.map(x => x.riotIdGameName ? x.riotIdGameName + "#" + (x.riotIdTagline || "") : "")];
}

// ---------- Prime League: Riot-IDs von der Teamseite ----------
async function primeTeam(url, ctx, cors) {
  let u;
  try { u = new URL(url.searchParams.get("url") || ""); } catch (e) { return json({ error: "Ungültiger Link." }, 400, cors); }
  if (u.protocol !== "https:" || !/(^|\.)primeleague\.gg$/.test(u.hostname)) return json({ error: "Nur Links von primeleague.gg." }, 400, cors);
  const cacheKey = new Request("https://pl.cache/" + encodeURIComponent(u.href));
  const hit = await edgeCache().match(cacheKey);
  if (hit) return withCors(hit, cors);
  let html = "";
  try {
    const r = await fetch(u.href, { headers: { "User-Agent": "Mozilla/5.0 (DraftBoard Team-Import)", "Accept-Language": "de-DE" } });
    if (!r.ok) return json({ error: "Prime League antwortet mit " + r.status + "." }, 502, cors);
    html = await r.text();
  } catch (e) { return json({ error: "Prime League nicht erreichbar." }, 502, cors); }
  const res = json({ url: u.href, ...parsePrimeTeam(html) }, 200, { "Cache-Control": "public, max-age=1800" });
  ctx.waitUntil(edgeCache().put(cacheKey, res.clone()));
  return withCors(res, cors);
}
const decodeHtml = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
function parsePrimeTeam(html) {
  const meta = n => { const m = html.match(new RegExp(`<meta[^>]+property="og:${n}"[^>]+content="([^"]*)"`, "i")) || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="og:${n}"`, "i")); return m ? decodeHtml(m[1]).trim() : ""; };
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  let name = h1 ? decodeHtml(h1.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : meta("title");
  name = name.replace(/\s*[|–-]\s*Prime League.*$/i, "").trim();
  const tagM = name.match(/^(.*?)\s*\(([^)]{1,6})\)$/);
  const ids = [], seen = new Set();
  const add = (n, t, hint = "") => { n = decodeHtml(String(n)).replace(/\s+/g, " ").trim(); t = decodeHtml(String(t)).trim(); if (n.length < 3 || n.length > 16 || t.length < 2 || t.length > 5) return; const k = (n + "#" + t).toLowerCase(); if (seen.has(k)) return; seen.add(k); ids.push({ id: n + "#" + t, hint }); };
  // 1) JSON (z. B. Next.js-Daten): gameName/tagLine oder riotId
  for (const m of html.matchAll(/"(?:gameName|riotIdGameName)"\s*:\s*"([^"]{3,16})"\s*,\s*"(?:tagLine|riotIdTagline)"\s*:\s*"([^"]{2,5})"/g)) add(m[1], m[2]);
  for (const m of html.matchAll(/"riotId"\s*:\s*"([^"#]{3,16})#([^"]{2,5})"/g)) add(m[1], m[2]);
  // 2) sichtbarer Text: Name#TAG (mit Rolle in der Nähe, falls vorhanden)
  const text = decodeHtml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, "\n"));
  const lines = text.split(/\n+/).map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  const label = x => /^(coach|trainer|head coach)\b/i.test(x) ? "Coach" : /^(ersatz|substitute|sub\b|bank)/i.test(x) ? "Ersatz" : /^(captain|kapitän)\b/i.test(x) ? "Captain" : "";
  lines.forEach((ln, i) => {
    const m = ln.match(/^([\p{L}\p{N}_. ]{3,16})#([\p{L}\p{N}]{2,5})$/u) || ln.match(/(?:^|[\s:])([\p{L}\p{N}_.][\p{L}\p{N}_. ]{2,15})#([\p{L}\p{N}]{2,5})(?=$|[\s,)])/u);
    if (!m) return;
    // Rolle: Label direkt danach, oder davor mit Doppelpunkt bzw. als Abschnitts-Überschrift (z. B. „Ersatzspieler“)
    const nx = lines[i + 1] || "", after = /:$/.test(nx) || /^(ersatzspieler|substitutes|coaches)$/i.test(nx) ? "" : label(nx), prev = lines[i - 1] || "", before = /:$/.test(prev) || /^(ersatzspieler|substitutes|coaches)$/i.test(prev) ? label(prev) : "";
    const inLine = /:/.test(ln) ? label(ln) : "";
    add(m[1], m[2], inLine || before || after);
  });
  return { name: tagM ? tagM[1].trim() : name, tag: tagM ? tagM[2].trim() : "", players: ids.slice(0, 15) };
}
