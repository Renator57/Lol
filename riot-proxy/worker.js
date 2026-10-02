// Riot-API-Proxy für das Draft Board (Cloudflare Worker)
// Hält den Riot-API-Key geheim und fasst die letzten Spiele eines Spielers zusammen.
//
//   GET /?id=Name%23TAG&region=euw&queue=ranked&count=20
//   GET /health
//
// Secrets / Variablen (siehe README.md):
//   RIOT_API_KEY     – Pflicht, per `wrangler secret put RIOT_API_KEY`
//   ALLOWED_ORIGINS  – empfohlen, kommagetrennt, z. B. "https://name.github.io" (Standard: alle)
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
const VERSION = 4;           // vom Board geprüft (Einstellungen → Testen)
const MAX_COUNT = 30;
// Cloudflare-eigener Standard-Cache (caches.default fehlt in den Browser-Typen)
const edgeCache = () => /** @type {Cache} */ (/** @type {any} */ (caches).default);
const CACHE_RESULT = 600;      // fertige Antwort: 10 Min.
const CACHE_ACCOUNT = 2592000; // Riot-ID → PUUID: 30 Tage (PUUID ändert sich nie)
const CACHE_IDS = 300;         // Liste der letzten Spiele: 5 Min.
const CACHE_LEAGUE = 1800;     // Rang: 30 Min.
const CACHE_MATCH = 2592000;   // Match-Details ändern sich nie: 30 Tage

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "GET") return json({ error: "Nur GET erlaubt." }, 405, cors);
    if (!cors["Access-Control-Allow-Origin"]) return json({ error: "Origin nicht erlaubt." }, 403, cors);

    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true, key: !!env.RIOT_API_KEY, version: VERSION }, 200, cors);
    if (!env.RIOT_API_KEY) return json({ error: "RIOT_API_KEY fehlt im Worker." }, 500, cors);

    // unsichtbare Steuerzeichen (aus dem LoL-Client kopiert) entfernen, sonst antwortet Riot mit 400
    const id = (url.searchParams.get("id") || "").normalize("NFC").replace(/[\p{Cf}\p{Cc}]/gu, "").replace(/\s+/g, " ").trim();
    const region = (url.searchParams.get("region") || "euw").toLowerCase();
    const queue = (url.searchParams.get("queue") || "ranked").toLowerCase();
    const count = Math.min(MAX_COUNT, Math.max(1, parseInt(url.searchParams.get("count") || "20", 10) || 20));
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
    const cacheKey = new Request(`https://cache.local/v3/${kt}/${region}/${queue}/${count}/${encodeURIComponent(name.toLowerCase() + "#" + tag.toLowerCase())}`);
    const hit = await edgeCache().match(cacheKey);
    if (hit) return withCors(hit, cors);

    const riot = makeRiot(env, ctx, kt);
    const api = host => `https://${host}.api.riotgames.com`;
    try {
      const accUrl = `${api(reg.regional)}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
      let acc = await riot(accUrl, CACHE_ACCOUNT, "Konto");
      const q = QUEUES[queue];
      const load = a => Promise.all([
        riot(`${api(reg.regional)}/lol/match/v5/matches/by-puuid/${a.puuid}/ids?start=0&count=${count}${q ? "&" + q : ""}`, CACHE_IDS, "Spieleliste"),
        riot(`${api(reg.platform)}/lol/league/v4/entries/by-puuid/${a.puuid}`, CACHE_LEAGUE, "Rang").catch(() => []),
      ]);
      let ids, leagues;
      try { [ids, leagues] = await load(acc); }
      catch (e) {
        // veraltete PUUID im Cache? Konto einmal frisch abfragen und erneut versuchen
        if (e.status !== 400 && e.status !== 404 && e.status !== 403) throw e;
        acc = await riot(accUrl, CACHE_ACCOUNT, "Konto", true);
        [ids, leagues] = await load(acc);
      }
      const puuid = acc.puuid;
      // Erst alles aus dem Cache holen (kostet kein Riot-Limit) …
      const urls = ids.map(mid => `${api(reg.regional)}/lol/match/v5/matches/${mid}`);
      const matches = await Promise.all(urls.map(u => cached(u, kt)));
      // … dann nur so viele neue Spiele laden, wie ins 2-Minuten-Budget passen
      const missing = urls.map((u, i) => (matches[i] ? -1 : i)).filter(i => i >= 0);
      const allowed = Math.min(missing.length, budgetLeft(reg.regional));
      await pool(missing.slice(0, allowed), 4, async i => {
        if (budgetLeft(reg.regional) <= 0) return; // Budget unterwegs aufgebraucht
        matches[i] = await riot(urls[i], CACHE_MATCH, "Match").catch(() => null);
      });
      const loaded = matches.filter(Boolean);
      const partial = loaded.length < ids.length;
      const result = summarize(acc, puuid, loaded, leagues, { region, queue, requested: ids.length });
      result.partial = partial;
      result.loaded = loaded.length;
      result.requested = ids.length;
      if (partial) result.retryIn = retryEstimate(reg.regional);
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
        : "Riot-API nicht erreichbar.";
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

function summarize(acc, puuid, matches, leagues, meta) {
  const champs = {}, positions = {};
  let games = 0, wins = 0, k = 0, d = 0, a = 0;
  const recent = [], list = [];
  for (const m of matches) {
    const info = m.info || {};
    if (info.gameDuration && info.gameDuration < 300) continue; // Remakes ignorieren
    const p = (info.participants || []).find(x => x.puuid === puuid);
    if (!p) continue;
    games++; if (p.win) wins++;
    k += p.kills; d += p.deaths; a += p.assists;
    const pos = p.teamPosition || p.individualPosition || "";
    if (pos && pos !== "Invalid") positions[pos] = (positions[pos] || 0) + 1;
    const c = champs[p.championName] || (champs[p.championName] = { id: p.championName, games: 0, wins: 0, k: 0, d: 0, a: 0, pos: {} });
    c.games++; if (p.win) c.wins++;
    c.k += p.kills; c.d += p.deaths; c.a += p.assists;
    if (pos) c.pos[pos] = (c.pos[pos] || 0) + 1;
    // kompakte Spieleliste: erkennt im Board gemeinsame Spiele (Duos) der Gegner
    if (m.metadata && m.metadata.matchId) list.push([m.metadata.matchId, p.championName, p.win ? 1 : 0, pos]);
    if (recent.length < 10) recent.push({ champ: p.championName, win: !!p.win, k: p.kills, d: p.deaths, a: p.assists, pos, queue: info.queueId, at: info.gameStartTimestamp || info.gameCreation, dur: info.gameDuration });
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
  return ok ? { "Access-Control-Allow-Origin": ok, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400", "Vary": "Origin" } : {};
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
function withCors(res, cors) { const r = new Response(res.body, res); Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v)); return r; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
