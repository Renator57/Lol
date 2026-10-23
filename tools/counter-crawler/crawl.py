#!/usr/bin/env python3
"""
Counter-Crawler für das Draft Board
===================================
Lädt High-Elo-Spiele (Solo/Duo) über die offizielle Riot-API und zählt Lane-Matchups:
Wie oft hat Champion A auf derselben Position gegen Champion B gewonnen?
Ergebnis: counters.json → im Board unter „Matchups → Counter-Daten laden“ einlesen.

Nur Python 3.8+ nötig (keine Zusatzpakete).

    set RIOT_API_KEY=RGAPI-...            (Windows, oder Datei .env mit RIOT_API_KEY=... daneben)
    python crawl.py                       (Standard: EUW, Challenger–Master, 2 Stunden)
    python crawl.py --stunden 6 --ligen alle          (ALLE Ränge Iron–Challenger, sehr viele Daten)
    Limits werden automatisch aus Riots Antwort gelesen – mit Production Key einfach den neuen Key in .env eintragen.
    python crawl.py --ligen diamond,emerald,platinum   (nur bestimmte Ränge)
    python crawl.py --nur-export          (nur counters.json aus den bisher gesammelten Daten schreiben)

Patches: Zuerst wird der aktuelle Patch gesammelt (bis --ziel-aktuell Spiele), danach geht der Crawler
in die 5 vorherigen Patches zurück (je bis --ziel-alt Spiele). Alle 6 Patches bleiben in crawl.db und
in counters.json erhalten – auch wenn ein neuer Patch erscheint, gehen die alten Daten nicht verloren.

Abbrechen mit Strg+C ist jederzeit ok – beim nächsten Start geht es dort weiter (crawl.db).
"""
import argparse, bisect, json, os, sqlite3, sys, threading, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
REGIONS = {  # Plattform → regionaler Host für Match-V5
    "euw1": "europe", "eun1": "europe", "tr1": "europe", "ru": "europe",
    "na1": "americas", "br1": "americas", "la1": "americas", "la2": "americas",
    "kr": "asia", "jp1": "asia", "oc1": "sea", "vn2": "sea", "sg2": "sea", "tw2": "sea",
}
LANES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]
APEX = ["challenger", "grandmaster", "master"]
TIERS_DIV = ["diamond", "emerald", "platinum", "gold", "silver", "bronze", "iron"]  # haben Divisionen I–IV
DIVS = ["I", "II", "III", "IV"]
ALL_LEAGUES = APEX + TIERS_DIV
UA = "DraftBoard-CounterCrawler/1.0"


def load_key():
    key = os.environ.get("RIOT_API_KEY", "").strip()
    env = os.path.join(HERE, ".env")
    if not key and os.path.exists(env):
        for line in open(env, encoding="utf-8"):
            if line.strip().startswith("RIOT_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key.startswith("RGAPI-"):
        sys.exit("RIOT_API_KEY fehlt. Entweder als Umgebungsvariable setzen oder eine Datei .env neben crawl.py "
                 "anlegen mit der Zeile:  RIOT_API_KEY=RGAPI-...")
    return key


class Riot:
    """Hält die Limits des Keys ein. Startwerte = Personal Key (20/1 s, 100/120 s); sobald Riot antwortet,
    werden die echten Limits aus X-App-Rate-Limit / X-Method-Rate-Limit übernommen – ein Production Key
    wird also automatisch voll genutzt. Thread-sicher, bei 429 pausieren alle Threads gemeinsam."""
    def __init__(self, key, per_sec=20, per_2min=100, auto=True):
        self.key, self.calls, self.auto = key, [], auto
        self.limits = [(per_sec, 1.0), (per_2min, 120.0)]
        self.count, self.lock, self.block_until, self.announced = 0, threading.Lock(), 0.0, ""

    @staticmethod
    def _parse(h):
        out = []
        for part in (h or "").split(","):
            try:
                n, w = part.strip().split(":"); out.append((int(n), float(w)))
            except ValueError:
                pass
        return out

    def _adopt(self, headers):
        if not self.auto:
            return
        lim = self._parse(headers.get("X-App-Rate-Limit")) + self._parse(headers.get("X-Method-Rate-Limit"))
        if lim:
            key = ",".join(f"{n}/{int(w)}s" for n, w in lim)
            with self.lock:
                self.limits = lim
            if key != self.announced:
                self.announced = key; print(f"  Limits laut Riot: {key}")

    def _reserve(self):
        while True:
            with self.lock:
                now = time.time()
                maxw = max(w for _, w in self.limits)
                cut = bisect.bisect_left(self.calls, now - maxw)
                if cut: del self.calls[:cut]
                pause = max(0.0, self.block_until - now)
                for n, win in self.limits:
                    i = bisect.bisect_left(self.calls, now - win)
                    if len(self.calls) - i >= max(1, n - 1):  # ein Aufruf Reserve
                        pause = max(pause, win - (now - self.calls[i]) + 0.05)
                if pause <= 0:
                    self.calls.append(now); self.count += 1
                    return
            time.sleep(min(pause, 5))

    def get(self, url):
        for attempt in range(6):
            self._reserve()
            req = urllib.request.Request(url, headers={"X-Riot-Token": self.key, "User-Agent": UA})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    self._adopt(r.headers)
                    return json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait = int(e.headers.get("Retry-After") or 10)
                    with self.lock:
                        self.block_until = max(self.block_until, time.time() + wait + 1)
                    print(f"  Riot-Limit erreicht – warte {wait} s …"); continue
                if e.code in (500, 502, 503, 504):
                    time.sleep(2 + attempt * 2); continue
                if e.code in (401, 403):
                    sys.exit("Riot lehnt den API-Key ab (401/403). Key prüfen bzw. neu erzeugen.")
                if e.code == 404:
                    return None
                raise
            except (urllib.error.URLError, TimeoutError):
                time.sleep(3 + attempt * 2)
        return None

def db_open(path):
    db = sqlite3.connect(path)
    db.executescript("""
      CREATE TABLE IF NOT EXISTS players(puuid TEXT PRIMARY KEY, done INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, state INTEGER DEFAULT 0, patch TEXT);
      CREATE TABLE IF NOT EXISTS mu(patch TEXT, lane TEXT, a TEXT, b TEXT, games INTEGER, wins INTEGER, PRIMARY KEY(patch, lane, a, b));
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS pdone(puuid TEXT, patch TEXT, at INTEGER, PRIMARY KEY(puuid, patch));
    """)
    # ältere crawl.db: Spielzeit je Match ergänzen (daraus lernt der Crawler, wann welcher Patch lief)
    if "ts" not in [r[1] for r in db.execute("PRAGMA table_info(matches)")]:
        db.execute("ALTER TABLE matches ADD COLUMN ts INTEGER")
        db.commit()
    return db


def pkey(patch):
    try:
        return tuple(int(x) for x in patch.split(".")[:2])
    except ValueError:
        return (0, 0)


def recent_patches(n):
    """Die letzten n Patches laut Data Dragon, neuester zuerst (z. B. ['16.20', '16.19', …])."""
    try:
        with urllib.request.urlopen("https://ddragon.leagueoflegends.com/api/versions.json", timeout=20) as r:
            vs = json.loads(r.read().decode())
    except Exception:
        return []
    out = []
    for v in vs:
        p = ".".join(v.split(".")[:2])
        if v.count(".") == 2 and p not in out and not v.startswith("lolpatch"):
            out.append(p)
        if len(out) >= n:
            break
    return out


def patch_counts(db):
    return dict(db.execute("SELECT patch, COUNT(*) FROM matches WHERE state = 1 GROUP BY patch").fetchall())


def collect_players(riot, db, platform, leagues, max_players, pages_per_div):
    base = f"https://{platform}.api.riotgames.com/lol/league/v4"
    def count():
        return db.execute("SELECT COUNT(*) FROM players").fetchone()[0]
    if count() >= max_players:
        return
    for lg in leagues:
        if count() >= max_players:
            break
        if lg in APEX:
            data = riot.get(f"{base}/{lg}leagues/by-queue/RANKED_SOLO_5x5") or {}
            entries = data.get("entries", [])
            added = 0
            for e in entries:
                if e.get("puuid"):
                    added += db.execute("INSERT OR IGNORE INTO players(puuid) VALUES (?)", (e["puuid"],)).rowcount
            db.commit()
            print(f"  {lg}: {len(entries)} Spieler, {added} neu")
        else:
            tier = lg.upper()
            total = 0
            for div in DIVS:
                page = 1
                while page <= pages_per_div and count() < max_players:
                    part = riot.get(f"{base}/entries/RANKED_SOLO_5x5/{tier}/{div}?page={page}") or []
                    if not part:
                        break
                    for e in part:
                        if e.get("puuid"):
                            db.execute("INSERT OR IGNORE INTO players(puuid) VALUES (?)", (e["puuid"],))
                            total += 1
                    db.commit()
                    page += 1
                if count() >= max_players:
                    break
            print(f"  {lg}: ~{total} Spieler gesammelt (bis {pages_per_div} Seiten/Division)")

def record(db, info, patch):
    parts = info.get("participants") or []
    by = {}
    for p in parts:
        pos = p.get("teamPosition") or ""
        if pos in LANES:
            by.setdefault(pos, {})[p.get("teamId")] = p
    for lane, teams in by.items():
        if len(teams) != 2: continue
        a, b = teams.get(100), teams.get(200)
        if not a or not b: continue
        for x, y in ((a, b), (b, a)):
            db.execute("""INSERT INTO mu(patch, lane, a, b, games, wins) VALUES (?,?,?,?,1,?)
                          ON CONFLICT(patch, lane, a, b) DO UPDATE SET games = games + 1, wins = wins + excluded.wins""",
                       (patch, lane, x["championName"], y["championName"], 1 if x.get("win") else 0))


def export(db, out, region, patches, leagues):
    """counters.json: \"m\" = aktueller Patch (wie bisher), \"byPatch\" = jeder der Patches einzeln."""
    counts = patch_counts(db)
    newer = [p for p in counts if patches and pkey(p) > pkey(patches[0])]
    patches = sorted(set(patches) | set(newer), key=pkey, reverse=True)[:max(len(patches), 1)]
    have = [p for p in patches if counts.get(p)]
    by, rows_total = {}, 0
    for p in have:
        m = {}
        for lane, a, b, g, w in db.execute("SELECT lane, a, b, games, wins FROM mu WHERE patch = ?", (p,)):
            m.setdefault(lane, {}).setdefault(a, {})[b] = [g, w]
            rows_total += 1
        by[p] = {"matches": counts[p], "m": m}
    cur = patches[0] if patches else ""
    data = {"v": 2, "source": "Riot-API", "region": region, "patch": cur, "leagues": leagues,
            "matches": counts.get(cur, 0), "generated": int(time.time() * 1000),
            "m": by.get(cur, {}).get("m", {}), "patches": have, "byPatch": by}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(out) / 1024
    print(f"\n✓ {out} geschrieben: {sum(counts.get(p, 0) for p in have)} Spiele, {rows_total} Matchup-Zeilen, {size:.0f} KB")
    print("  " + " · ".join(f"Patch {p}: {counts.get(p, 0)}" for p in patches))


def main():
    ap = argparse.ArgumentParser(description="Lane-Matchups aus High-Elo-Spielen für das Draft Board")
    ap.add_argument("--region", default="euw1", choices=sorted(REGIONS), help="Plattform (Standard: euw1)")
    ap.add_argument("--ligen", default="challenger,grandmaster,master", help="z. B. challenger,grandmaster,master · \"alle\" = alle Ränge Iron–Challenger")
    ap.add_argument("--stunden", type=float, default=2.0, help="maximale Laufzeit (Standard: 2)")
    ap.add_argument("--max-spiele", type=int, default=200000, help="höchstens so viele Spiele auswerten")
    ap.add_argument("--spieler", type=int, default=8000, help="höchstens so viele Spieler sammeln")
    ap.add_argument("--seiten-pro-division", type=int, default=6, dest="seiten_pro_division", help="bei Iron–Diamond: Seiten je Division (je ~205 Spieler)")
    ap.add_argument("--spiele-pro-spieler", type=int, default=20, help="neueste Spiele je Spieler (Standard: 20)")
    ap.add_argument("--tage", type=int, default=14, help="Länge eines Patches in Tagen für die Zeitfenster (Standard: 14)")
    ap.add_argument("--patches", type=int, default=6, help="aktueller + ältere Patches, die gesammelt und behalten werden (Standard: 6)")
    ap.add_argument("--ziel-aktuell", type=int, default=50000, dest="ziel_aktuell", help="erst so viele Spiele vom aktuellen Patch, dann in ältere Patches (Standard: 50000)")
    ap.add_argument("--ziel-alt", type=int, default=30000, dest="ziel_alt", help="so viele Spiele je älterem Patch (Standard: 30000)")
    ap.add_argument("--limit", default="", help="feste Limits statt automatisch, z. B. 20,100 (sonst liest der Crawler die Limits aus Riots Antwort)")
    ap.add_argument("--threads", type=int, default=8, help="parallele Downloads (Standard: 8; nützt v. a. mit Production Key)")
    ap.add_argument("--out", default=os.path.join(HERE, "counters.json"))
    ap.add_argument("--nur-export", action="store_true", help="nichts laden, nur counters.json schreiben")
    ap.add_argument("--neu", action="store_true", help="komplett von vorne: crawl.db löschen und neu sammeln")
    args = ap.parse_args()

    dbpath = os.path.join(HERE, "crawl.db")
    if args.neu and os.path.exists(dbpath):
        os.remove(dbpath); print("Neu: crawl.db gelöscht, es wird von vorne gesammelt.")
    db = db_open(dbpath)
    patches = recent_patches(max(1, args.patches))
    if not patches:  # Data Dragon nicht erreichbar → die Patches aus der Datenbank nehmen
        patches = sorted(patch_counts(db), key=pkey, reverse=True)[:max(1, args.patches)]
    if not patches:
        sys.exit("Konnte den aktuellen Patch nicht ermitteln (Data Dragon nicht erreichbar).")
    leagues = [x.strip().lower() for x in args.ligen.split(",") if x.strip()]
    if "alle" in leagues or "all" in leagues:
        leagues = list(ALL_LEAGUES)
    unknown = [x for x in leagues if x not in ALL_LEAGUES]
    if unknown:
        sys.exit("Unbekannte Liga(en): " + ", ".join(unknown) + "\nErlaubt: " + ", ".join(ALL_LEAGUES) + "  oder  alle")
    if args.nur_export:
        return export(db, args.out, args.region, patches, leagues)

    if args.limit:
        per_sec, per_2min = (int(x) for x in args.limit.split(","))
        riot = Riot(load_key(), per_sec, per_2min, auto=False)
    else:
        riot = Riot(load_key())
    regional = REGIONS[args.region]
    end = time.time() + args.stunden * 3600
    oldest = pkey(patches[-1])
    if not db.execute("SELECT 1 FROM meta WHERE k = 'v2'").fetchone():  # einmalig beim Umstieg auf mehrere Patches
        # früher als „falscher Patch“ verworfene Spiele aus den älteren Patches nochmal laden
        ph = ",".join("?" * len(patches[1:]))
        if ph:
            db.execute(f"UPDATE matches SET state = 0 WHERE state = 2 AND patch IN ({ph})", patches[1:])
        # bisher abgefragte Spieler zählen als „aktueller Patch erledigt“
        db.execute("INSERT OR IGNORE INTO pdone(puuid, patch, at) SELECT puuid, ?, ? FROM players WHERE done = 1", (patches[0], int(time.time())))
        db.execute("INSERT OR REPLACE INTO meta(k, v) VALUES ('v2', '1')"); db.commit()
    REFRESH = 3 * 86400  # beim aktuellen Patch Spieler nach 3 Tagen erneut abfragen (neue Spiele)
    print(f"Region {args.region} · Ligen {', '.join(leagues)} · Patches {', '.join(patches)} · bis {time.strftime('%H:%M', time.localtime(end))} Uhr")

    def starts():
        """Beginn jedes Patches: frühestes gesammeltes Spiel; unbekannt → geschätzt (--tage pro Patch)."""
        seen = {p: (lo, hi) for p, lo, hi in db.execute("SELECT patch, MIN(ts), MAX(ts) FROM matches WHERE state = 1 AND ts IS NOT NULL GROUP BY patch")}
        out, prev = [], time.time()
        for i, p in enumerate(patches):
            older = seen.get(patches[i + 1]) if i + 1 < len(patches) else None
            # frühestes Spiel dieses Patches, sonst letztes Spiel des Patches davor, sonst geschätzt
            s0 = (seen.get(p) or (None,))[0] or (older[1] if older else None)
            s0 = s0 if s0 and s0 < prev else prev - args.tage * 86400
            out.append(s0); prev = s0
        return out

    def window(k):  # Zeitfenster für Patch k (0 = aktueller), mit etwas Rand – jedes Spiel zählt eh für seinen echten Patch
        st = starts()
        hi = time.time() if k == 0 else st[k - 1] + 86400
        return int(st[k] - 2 * 86400), int(hi)

    def todo_sql(k):
        cutoff = int(time.time()) - REFRESH if k == 0 else 2 ** 62
        return ("SELECT puuid FROM players WHERE puuid NOT IN (SELECT puuid FROM pdone WHERE patch = ? AND at > ?)", (patches[k], cutoff))

    def pick_window(counts):
        """Zuerst der aktuelle Patch bis zum Ziel, dann die älteren der Reihe nach, danach wieder der aktuelle."""
        order = []
        if counts.get(patches[0], 0) < args.ziel_aktuell:
            order.append(0)
        order += [k for k in range(1, len(patches)) if counts.get(patches[k], 0) < args.ziel_alt]
        order += [k for k in range(len(patches)) if k not in order]
        for k in order:
            q, a = todo_sql(k)
            if db.execute(q + " LIMIT 1", a).fetchone():
                return k
        return None

    print("1) Spieler sammeln …")
    collect_players(riot, db, args.region, leagues, max_players=args.spieler, pages_per_div=args.seiten_pro_division)
    done = lambda: db.execute("SELECT COUNT(*) FROM matches WHERE state = 1 AND patch = ?", (patches[0],)).fetchone()[0]
    total = lambda: db.execute("SELECT COUNT(*) FROM matches WHERE state = 1").fetchone()[0]
    last_export = time.time()
    try:
        print("2) Spiele laden und Matchups zählen (Strg+C beendet und speichert) …")
        pool = ThreadPoolExecutor(max_workers=max(1, args.threads))
        url = lambda mid: f"https://{regional}.api.riotgames.com/lol/match/v5/matches/{mid}"
        last_print, cur_window = 0, None
        while time.time() < end and done() < args.max_spiele:
            batch = [r[0] for r in db.execute("SELECT id FROM matches WHERE state = 0 LIMIT ?", (max(1, args.threads) * 4,)).fetchall()]
            if not batch:  # neue Match-IDs von den nächsten Spielern holen (parallel)
                k = pick_window(patch_counts(db))
                if k is None:
                    print("Alle Spieler in allen Patches abgearbeitet."); break
                if k != cur_window:
                    cur_window = k
                    print(f"  → sammle jetzt Patch {patches[k]}" + (" (aktueller Patch)" if k == 0 else f" ({k} zurück)"))
                q, a = todo_sql(k)
                pus = [r[0] for r in db.execute(q + " ORDER BY RANDOM() LIMIT ?", a + (max(1, args.threads),)).fetchall()]
                lo, hi = window(k)
                q = urllib.parse.urlencode({"queue": 420, "start": 0, "count": args.spiele_pro_spieler, "startTime": lo, "endTime": hi})
                for pu, ids in zip(pus, pool.map(lambda pu: riot.get(f"https://{regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/{pu}/ids?{q}") or [], pus)):
                    db.executemany("INSERT OR IGNORE INTO matches(id) VALUES (?)", [(i,) for i in ids])
                    db.execute("UPDATE players SET done = 1 WHERE puuid = ?", (pu,))
                    db.execute("INSERT OR REPLACE INTO pdone(puuid, patch, at) VALUES (?, ?, ?)", (pu, patches[k], int(time.time())))
                db.commit()
                continue
            for mid, m in zip(batch, pool.map(lambda mid: riot.get(url(mid)), batch)):
                info = (m or {}).get("info") or {}
                gv = ".".join(str(info.get("gameVersion", "")).split(".")[:2])
                if not info or info.get("queueId") != 420 or (info.get("gameDuration") or 0) < 300:
                    db.execute("UPDATE matches SET state = 2, patch = ? WHERE id = ?", (gv, mid))
                elif pkey(gv) < oldest:  # älter als die gesammelten Patches
                    db.execute("UPDATE matches SET state = 3, patch = ? WHERE id = ?", (gv, mid))
                else:  # jedes Spiel zählt für seinen eigenen Patch (auch ein ganz neuer, den Data Dragon noch nicht kennt)
                    record(db, info, gv)
                    db.execute("UPDATE matches SET state = 1, patch = ?, ts = ? WHERE id = ?", (gv, int((info.get("gameCreation") or 0) / 1000) or None, mid))
            db.commit()
            n = total()
            if n - last_print >= 25:
                last_print = n
                left = max(0, int((end - time.time()) / 60))
                print(f"  {done()} Spiele Patch {patches[0]} · {n} gesamt ({len(patches)} Patches) · {riot.count} Riot-Aufrufe · noch {left} Min.")
            if time.time() - last_export > 600:  # alle 10 Minuten Zwischenstand schreiben
                export(db, args.out, args.region, patches, leagues); last_export = time.time()
    except KeyboardInterrupt:
        print("\nAbgebrochen – Zwischenstand wird gespeichert.")
    export(db, args.out, args.region, patches, leagues)


if __name__ == "__main__":
    main()
