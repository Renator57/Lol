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
    python crawl.py --ligen diamond,emerald,platinum   (nur bestimmte Ränge)
    python crawl.py --nur-export          (nur counters.json aus den bisher gesammelten Daten schreiben)

Abbrechen mit Strg+C ist jederzeit ok – beim nächsten Start geht es dort weiter (crawl.db).
"""
import argparse, json, os, sqlite3, sys, time, urllib.error, urllib.parse, urllib.request
from collections import deque

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
    """Hält beide Limits des Personal Keys ein (Standard 20/1 s und 100/120 s) und wartet bei 429."""
    def __init__(self, key, per_sec=20, per_2min=100):
        self.key, self.calls = key, deque()
        self.limits = [(per_sec, 1.0), (per_2min, 120.0)]
        self.count = 0

    def _wait(self):
        while True:
            now = time.time()
            while self.calls and now - self.calls[0] > 120:
                self.calls.popleft()
            pause = 0
            for n, win in self.limits:
                recent = [t for t in self.calls if now - t < win]
                if len(recent) >= n - 1:  # ein Aufruf Reserve
                    pause = max(pause, win - (now - recent[0]) + 0.05)
            if pause <= 0:
                return
            time.sleep(pause)

    def get(self, url):
        for attempt in range(6):
            self._wait()
            self.calls.append(time.time()); self.count += 1
            req = urllib.request.Request(url, headers={"X-Riot-Token": self.key, "User-Agent": UA})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait = int(e.headers.get("Retry-After") or 10)
                    print(f"  Riot-Limit erreicht – warte {wait} s …"); time.sleep(wait + 1); continue
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
    """)
    return db


def current_patch():
    try:
        with urllib.request.urlopen("https://ddragon.leagueoflegends.com/api/versions.json", timeout=20) as r:
            v = json.loads(r.read().decode())[0]
        return ".".join(v.split(".")[:2])
    except Exception:
        return ""


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

def same_patch(game_version, patch):
    return not patch or ".".join(str(game_version).split(".")[:2]) == patch


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


def export(db, out, region, patch, leagues):
    rows = db.execute("SELECT lane, a, b, SUM(games), SUM(wins) FROM mu WHERE patch = ? GROUP BY lane, a, b", (patch,)).fetchall()
    m = {}
    for lane, a, b, g, w in rows:
        m.setdefault(lane, {}).setdefault(a, {})[b] = [g, w]
    n = db.execute("SELECT COUNT(*) FROM matches WHERE state = 1 AND patch = ?", (patch,)).fetchone()[0]
    data = {"v": 1, "source": "Riot-API", "region": region, "patch": patch, "leagues": leagues, "matches": n,
            "generated": int(time.time() * 1000), "m": m}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(out) / 1024
    print(f"\n✓ {out} geschrieben: {n} Spiele, {len(rows)} Matchup-Zeilen, {size:.0f} KB")


def main():
    ap = argparse.ArgumentParser(description="Lane-Matchups aus High-Elo-Spielen für das Draft Board")
    ap.add_argument("--region", default="euw1", choices=sorted(REGIONS), help="Plattform (Standard: euw1)")
    ap.add_argument("--ligen", default="challenger,grandmaster,master", help="z. B. challenger,grandmaster,master · \"alle\" = alle Ränge Iron–Challenger")
    ap.add_argument("--stunden", type=float, default=2.0, help="maximale Laufzeit (Standard: 2)")
    ap.add_argument("--max-spiele", type=int, default=200000, help="höchstens so viele Spiele auswerten")
    ap.add_argument("--spieler", type=int, default=8000, help="höchstens so viele Spieler sammeln")
    ap.add_argument("--seiten-pro-division", type=int, default=6, dest="seiten_pro_division", help="bei Iron–Diamond: Seiten je Division (je ~205 Spieler)")
    ap.add_argument("--spiele-pro-spieler", type=int, default=20, help="neueste Spiele je Spieler (Standard: 20)")
    ap.add_argument("--tage", type=int, default=14, help="nur Spiele der letzten N Tage (Standard: 14)")
    ap.add_argument("--patch", default="", help="nur dieser Patch, z. B. 15.20 (Standard: aktueller Patch)")
    ap.add_argument("--alle-patches", action="store_true", help="Patch nicht filtern")
    ap.add_argument("--limit", default="20,100", help="Personal Key: 20,100 · Production Key z. B. 500,30000")
    ap.add_argument("--out", default=os.path.join(HERE, "counters.json"))
    ap.add_argument("--nur-export", action="store_true", help="nichts laden, nur counters.json schreiben")
    ap.add_argument("--neu", action="store_true", help="komplett von vorne: crawl.db löschen und neu sammeln")
    args = ap.parse_args()

    dbpath = os.path.join(HERE, "crawl.db")
    if args.neu and os.path.exists(dbpath):
        os.remove(dbpath); print("Neu: crawl.db gelöscht, es wird von vorne gesammelt.")
    db = db_open(dbpath)
    patch = "" if args.alle_patches else (args.patch or current_patch())
    leagues = [x.strip().lower() for x in args.ligen.split(",") if x.strip()]
    if "alle" in leagues or "all" in leagues:
        leagues = list(ALL_LEAGUES)
    unknown = [x for x in leagues if x not in ALL_LEAGUES]
    if unknown:
        sys.exit("Unbekannte Liga(en): " + ", ".join(unknown) + "\nErlaubt: " + ", ".join(ALL_LEAGUES) + "  oder  alle")
    if args.nur_export:
        return export(db, args.out, args.region, patch, leagues)

    per_sec, per_2min = (int(x) for x in args.limit.split(","))
    riot = Riot(load_key(), per_sec, per_2min)
    regional = REGIONS[args.region]
    end = time.time() + args.stunden * 3600
    start_time = int(time.time() - args.tage * 86400)
    print(f"Region {args.region} · Ligen {', '.join(leagues)} · Patch {patch or 'alle'} · bis {time.strftime('%H:%M', time.localtime(end))} Uhr")

    print("1) Spieler sammeln …")
    collect_players(riot, db, args.region, leagues, max_players=args.spieler, pages_per_div=args.seiten_pro_division)
    done = lambda: db.execute("SELECT COUNT(*) FROM matches WHERE state = 1 AND patch = ?", (patch,)).fetchone()[0]
    last_export = time.time()
    try:
        print("2) Spiele laden und Matchups zählen (Strg+C beendet und speichert) …")
        while time.time() < end and done() < args.max_spiele:
            mid = db.execute("SELECT id FROM matches WHERE state = 0 LIMIT 1").fetchone()
            if not mid:  # neue Match-IDs vom nächsten Spieler holen
                pu = db.execute("SELECT puuid FROM players WHERE done = 0 ORDER BY RANDOM() LIMIT 1").fetchone()
                if not pu:
                    print("Alle Spieler abgearbeitet."); break
                q = urllib.parse.urlencode({"queue": 420, "start": 0, "count": args.spiele_pro_spieler, "startTime": start_time})
                ids = riot.get(f"https://{regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/{pu[0]}/ids?{q}") or []
                db.executemany("INSERT OR IGNORE INTO matches(id) VALUES (?)", [(i,) for i in ids])
                db.execute("UPDATE players SET done = 1 WHERE puuid = ?", pu); db.commit()
                continue
            m = riot.get(f"https://{regional}.api.riotgames.com/lol/match/v5/matches/{mid[0]}")
            info = (m or {}).get("info") or {}
            gv = ".".join(str(info.get("gameVersion", "")).split(".")[:2])
            if not info or info.get("queueId") != 420 or (info.get("gameDuration") or 0) < 300 or not same_patch(info.get("gameVersion", ""), patch):
                db.execute("UPDATE matches SET state = 2, patch = ? WHERE id = ?", (gv, mid[0]))
            else:
                record(db, info, patch)
                db.execute("UPDATE matches SET state = 1, patch = ? WHERE id = ?", (patch, mid[0]))
            db.commit()
            n = done()
            if n % 25 == 0:
                left = max(0, int((end - time.time()) / 60))
                print(f"  {n} Spiele ausgewertet · {riot.count} Riot-Aufrufe · noch {left} Min.")
            if time.time() - last_export > 600:  # alle 10 Minuten Zwischenstand schreiben
                export(db, args.out, args.region, patch, leagues); last_export = time.time()
    except KeyboardInterrupt:
        print("\nAbgebrochen – Zwischenstand wird gespeichert.")
    export(db, args.out, args.region, patch, leagues)


if __name__ == "__main__":
    main()
