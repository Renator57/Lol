# Riot-Proxy für das Draft Board

Das Board lädt unter **Gegner-Picks → „Matchdaten laden“** die echten letzten Spiele der Gegner:
meistgespielte Champions mit Spielen, Winrate und KDA, den Rang (Solo/Duo), die Formkurve
der letzten Spiele und eine Warnung, wenn jemand meist eine andere Rolle spielt.

Die Riot-API darf nicht direkt aus dem Browser aufgerufen werden (CORS), und der API-Key
darf nicht in der öffentlichen `index.html` stehen. Deshalb läuft dazwischen dieser kleine
Cloudflare Worker. Er ist kostenlos (100.000 Aufrufe/Tag) und hält den Key geheim.

## 1. Riot-API-Key holen (Personal API Key)

Der Proxy ist auf einen **Personal API Key** ausgelegt: kostenlos, läuft nicht ab, gedacht für
„a small private community“, also genau euer Team.

1. Auf <https://developer.riotgames.com> mit dem Riot-Account einloggen.
2. **Register Product → Personal API Key**.
3. Riot verlangt eine **ausführliche Beschreibung**. Diese hier könnt ihr übernehmen
   (Teamname und Link anpassen):

   > **Product name:** Draft Board – [Teamname]
   >
   > **Description:** A private scouting and draft-planning board used only by the five players and
   > staff of our amateur team "[Teamname]" in the German Prime League. It is not public: the page is
   > password-protected and the API proxy only accepts requests from our own board.
   >
   > Before each league match we enter the Riot IDs of the opposing team. The tool then looks up each
   > player's PUUID (ACCOUNT-V1), their recent ranked match IDs and match details (MATCH-V5) and their
   > current rank (LEAGUE-V4). From this it shows, per player, the most played champions with games,
   > win rate and KDA, recent form and their main position, so we can plan bans and picks.
   >
   > Usage is very low: a few lookups per week, about 5 players × 15 matches per lookup. All requests
   > go through a small Cloudflare Worker that keeps the API key secret, caches match data (match
   > details for 30 days, account lookups for 30 days) and stays below the personal rate limits by
   > reading the X-App-Rate-Limit headers. No data is sold, shared or shown publicly.
   >
   > **Product URL:** [Link zum Board]

4. Bis der Key freigegeben ist, könnt ihr mit dem **Development API Key** aus dem Dashboard testen
   (läuft nach 24 Stunden ab).

> **Wichtig, laut Riot-Regeln:** Ein Personal Key darf nicht für eine öffentliche Seite benutzt werden.
> Deshalb unbedingt `ALLOWED_ORIGINS` setzen (Schritt 2) und im Board ein **Team-Passwort** festlegen
> (Einstellungen → Team-Passwort).

## 2. Worker deployen

### Variante A: im Browser (ohne Installation)

1. Bei <https://dash.cloudflare.com> anmelden (kostenloser Account).
2. **Workers & Pages → Erstellen → Worker erstellen**, Name z. B. `draftboard-riot`, **Bereitstellen**.
3. **Code bearbeiten**, den Inhalt von [`worker.js`](worker.js) komplett einfügen, **Bereitstellen**.
4. **Einstellungen → Variablen und Geheimnisse → Hinzufügen**:
   - Typ **Geheimnis**, Name `RIOT_API_KEY`, Wert = euer Riot-Key.
   - Typ **Text**, Name `ALLOWED_ORIGINS`, Wert = Adresse eures Boards ohne Pfad
     (z. B. `https://deinname.github.io`). Dann darf nur euer Board den Proxy benutzen. Beim Personal Key Pflicht.
5. Die Worker-Adresse kopieren, z. B. `https://draftboard-riot.deinname.workers.dev`.

### Variante B: mit der Kommandozeile

```bash
npm install -g wrangler
wrangler login
cd riot-proxy
wrangler secret put RIOT_API_KEY      # Key einfügen
wrangler deploy                       # gibt die Worker-URL aus
```

`ALLOWED_ORIGINS` steht in `wrangler.toml`.

## 3. Im Board eintragen

**Einstellungen (Zahnrad) → Riot-API (Matchdaten)** → Worker-URL einfügen → **Testen** → **Speichern**.
Die URL gilt danach für das ganze Team.

## Benutzen

1. In **Gegner-Picks** die Riot-IDs der Gegner eintragen (oder „IDs einfügen“).
2. Oben bei **RIOT** auswählen, welche Spiele zählen, und wie viele:

   | Filter | Spiele |
   |---|---|
   | Ranked | Solo/Duo und Flex |
   | Solo/Duo / Flex | nur diese Queue |
   | Turnier | Tournament-Code-Spiele, also z. B. Prime-League-Matches, falls Riot sie dem Account zuordnet |
   | Alle | auch Normals, ARAM usw. |

3. **Matchdaten laden**. Pro Spieler erscheinen Rang, Winrate, Formkurve und die meistgespielten Champions.
4. **Als Top-Picks** übernimmt die meistgespielten Champions in die Top-Picks. Damit funktionieren
   Bann-Plan, „Top-Picks als Gegnerteam“ und die Counter-Warnungen im Draft wie gewohnt.

Die geladenen Daten werden beim Gegner-Team gespeichert. Alle im Team sehen sie, ohne neu zu laden.

## Limits (Personal Key)

Riot erlaubt einem Personal Key **20 Aufrufe pro Sekunde** und **100 Aufrufe in 2 Minuten**.
Darauf ist alles abgestimmt:

- **Pro Spieler** braucht der Proxy beim ersten Laden etwa *Anzahl Spiele + 2* Aufrufe.
  Mit **15 Spielen (empfohlen)** passt ein ganzes Team mit 5 Spielern in ein 2-Minuten-Fenster.
- **Gedrosselt:** Der Proxy schickt höchstens etwa 14 Aufrufe pro Sekunde.
- **Budget:** Riot meldet bei jeder Antwort, wie viel vom Limit schon verbraucht ist. Der Proxy
  liest das mit und hört rechtzeitig auf, bevor Riot blockt.
- **Automatisch weiter:** Reicht das Budget nicht (z. B. bei 20 oder 30 Spielen), zeigt das Board
  „Riot-Limit erreicht · 6 von 20 Spielen geladen · Rest kommt automatisch in 30 s“ und lädt den Rest
  von selbst nach. Einfach offen lassen.
- **Cache:** Match-Details und Riot-IDs bleiben 30 Tage im Worker, der Rang 30 Minuten, die
  Spieleliste 5 Minuten, eine fertige Auswertung 10 Minuten. Erneutes Laden kostet deshalb fast nichts:
  nur neue Spiele werden geholt.
- **Je Region getrennt:** Riot zählt die Limits pro Server-Gruppe. Matches und Riot-IDs laufen über
  `europe`, der Rang über `euw1`.
- „API-Key ungültig oder abgelaufen“ heißt meistens, dass noch der 24-Stunden-Development-Key
  eingetragen ist. Dann den Personal Key als `RIOT_API_KEY` eintragen.
