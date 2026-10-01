// Riot-API-Proxy für das Draft Board (Cloudflare Worker)
// Hält den Riot-API-Key geheim und fasst die letzten Spiele eines Spielers zusammen.
//
//   GET /?id=Name%23TAG&region=euw&queue=ranked&count=20
//   GET /health
//
// Secrets / Variablen (siehe README.md):
//   RIOT_API_KEY     – Pflicht, per `wrangler secret put RIOT_API_KEY`
//   ALLOWED_ORIGINS  – optional, kommagetrennt, z. B. "https://name.github.io" (Standard: alle)

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
const MAX_COUNT = 30;
const CACHE_RESULT = 600;      // fertige Antwort: 10 Min.
const CACHE_ACCOUNT = 86400;   // Riot-ID → PUUID: 1 Tag
const CACHE_MATCH = 2592000;   // Match-Details ändern sich nie: 30 Tage

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "GET") return json({ error: "Nur GET erlaubt." }, 405, cors);
    if (!cors["Access-Control-Allow-Origin"]) return json({ error: "Origin nicht erlaubt." }, 403, cors);

    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true, key: !!env.RIOT_API_KEY }, 200, cors);
    if (!env.RIOT_API_KEY) return json({ error: "RIOT_API_KEY fehlt im Worker." }, 500, cors);

    const id = (url.searchParams.get("id") || "").trim();
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
    const cacheKey = new Request(`https://cache.local/v1/${region}/${queue}/${count}/${encodeURIComponent(name.toLowerCase() + "#" + tag.toLowerCase())}`);
    const hit = await caches.default.match(cacheKey);
    if (hit) return withCors(hit, cors);

    const riot = makeRiot(env, ctx);
    try {
      const acc = await riot(`https://${reg.regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, CACHE_ACCOUNT);
      const puuid = acc.puuid;
      const q = QUEUES[queue];
      const [ids, leagues] = await Promise.all([
        riot(`https://${reg.regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}${q ? "&" + q : ""}`, 0),
        riot(`https://${reg.platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`, 0).catch(() => []),
      ]);
      const matches = await pool(ids, 5, mid => riot(`https://${reg.regional}.api.riotgames.com/lol/match/v5/matches/${mid}`, CACHE_MATCH).catch(e => (e.status === 429 ? Promise.reject(e) : null)));
      const result = summarize(acc, puuid, matches.filter(Boolean), leagues, { region, queue, requested: ids.length });
      const res = json(result, 200, { "Cache-Control": `public, max-age=${CACHE_RESULT}` });
      ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
      return withCors(res, cors);
    } catch (e) {
      const status = e.status || 502;
      const msg = status === 404 ? "Riot-ID nicht gefunden."
        : status === 429 ? "Riot-Limit erreicht – kurz warten und nochmal versuchen."
        : status === 401 || status === 403 ? "API-Key ungültig oder abgelaufen."
        : "Riot-API nicht erreichbar.";
      return json({ error: msg, status }, status === 404 ? 404 : status === 429 ? 429 : 502, { ...cors, ...(e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {}) });
    }
  },
};

function makeRiot(env, ctx) {
  return async function riot(u, ttl) {
    const key = new Request(u);
    if (ttl) { const c = await caches.default.match(key); if (c) return c.json(); }
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(u, { headers: { "X-Riot-Token": env.RIOT_API_KEY } });
      if (r.ok) {
        const body = await r.text();
        if (ttl) ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } })));
        return JSON.parse(body);
      }
      const retryAfter = parseInt(r.headers.get("Retry-After") || "0", 10);
      if (r.status === 429 && attempt === 0 && retryAfter > 0 && retryAfter <= 5) { await sleep(retryAfter * 1000); continue; }
      if (r.status >= 500 && attempt === 0) { await sleep(500); continue; }
      const err = new Error("riot " + r.status); err.status = r.status; err.retryAfter = retryAfter; throw err;
    }
  };
}

function summarize(acc, puuid, matches, leagues, meta) {
  const champs = {}, positions = {};
  let games = 0, wins = 0;
  const recent = [];
  for (const m of matches) {
    const info = m.info || {};
    if (info.gameDuration && info.gameDuration < 300) continue; // Remakes ignorieren
    const p = (info.participants || []).find(x => x.puuid === puuid);
    if (!p) continue;
    games++; if (p.win) wins++;
    const pos = p.teamPosition || p.individualPosition || "";
    if (pos && pos !== "Invalid") positions[pos] = (positions[pos] || 0) + 1;
    const c = champs[p.championName] || (champs[p.championName] = { id: p.championName, games: 0, wins: 0, k: 0, d: 0, a: 0, pos: {} });
    c.games++; if (p.win) c.wins++;
    c.k += p.kills; c.d += p.deaths; c.a += p.assists;
    if (pos) c.pos[pos] = (c.pos[pos] || 0) + 1;
    if (recent.length < 10) recent.push({ champ: p.championName, win: !!p.win, k: p.kills, d: p.deaths, a: p.assists, pos, queue: info.queueId, at: info.gameStartTimestamp || info.gameCreation, dur: info.gameDuration });
  }
  return {
    riotId: `${acc.gameName}#${acc.tagLine}`,
    region: meta.region, queue: meta.queue,
    fetchedAt: Date.now(),
    games, wins,
    positions,
    champs: Object.values(champs).sort((a, b) => b.games - a.games || b.wins - a.wins),
    rank: (Array.isArray(leagues) ? leagues : []).map(l => ({ queue: l.queueType, tier: l.tier, rank: l.rank, lp: l.leaguePoints, wins: l.wins, losses: l.losses })),
    recent,
    partial: matches.length < meta.requested,
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
