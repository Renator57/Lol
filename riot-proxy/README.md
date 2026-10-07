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

## Duo-Queue (Verlauf → Duo)

Das Board findet Ranked-Spiele, in denen zwei aus eurem Team zusammen im selben Team waren.
Dafür im Board unter **Verlauf → Duo → Riot-IDs** eure eigenen Riot-IDs eintragen und
**Duo-Spiele laden** drücken. Pro Spieler werden die letzten 10, 20 oder 30 Spiele geladen
(Solo/Duo, Flex oder beides). Gemeinsame Spiele erkennt das Board an derselben Match-ID mit demselben Ergebnis.

Für KDA, Datum und Spieldauer pro Spiel braucht es die `worker.js` ab **Version 6**.

## Laufendes Spiel (Draft → „Laufendes Spiel“)

Sobald einer von euch im Ladebildschirm ist, holt der Knopf **Laufendes Spiel** im Draft über
**SPECTATOR-V5** (`/lol/spectator/v5/active-games/by-summoner/{puuid}`) die Champions beider Teams,
die Banns und eure Seite und trägt alles in den Draft ein. Die Riot-IDs eurer Spieler kommen aus
**Verlauf → Duo → Riot-IDs**. Gegner-Rollen werden geschätzt (Riot-ID aus dem Scouting, Smite,
Scouting-Picks, typische Bot-/Support-Champions) – kurz prüfen.

Die laufende Championauswahl selbst gibt Riot nicht über die API heraus, nur das gestartete Spiel.
Übernommen werden nur Spiele auf Summoner's Rift (Ranked, Normal, Flex, Clash, Turnier, Custom) – ARAM, Arena, URF usw. werden übersprungen.
Braucht die `worker.js` ab **Version 8**.

## Patchnotes (Klick auf „Patch xx.yy“ unter dem Logo)

Das Board zeigt die **offiziellen Patchnotes** von leagueoflegends.com als Karten:
alle Champions mit Fähigkeit, alt → neu, Buff/Nerf, Begründung, dazu Items,
Systeme/ARAM/Fehlerbehebungen und die Übersichtsgrafik. Eure Champions und die
des aktuellen Gegners stehen oben.

Die Riot-Seite erlaubt keinen direkten Abruf aus dem Browser, deshalb holt der
Worker sie (`GET /patch?v=26.20`, ohne API-Key, 6 Std. zwischengespeichert).
Braucht die `worker.js` ab **Version 10** – ohne sie zeigt das Board nur die
Werte aus Data Dragon (ohne Schadenswerte).

## Video-Upload (optional)

Damit ihr Spielvideos direkt im Board hochladen könnt (Verlauf → Spielnotizen → **⬆ Hochladen**),
speichert derselbe Worker sie in **Cloudflare R2**. Kostenlos sind 10 GB Speicher, und das Abspielen
kostet nichts (R2 berechnet keinen Datenverkehr). Für R2 verlangt Cloudflare einmalig eine hinterlegte
Zahlungsmethode, auch wenn ihr im kostenlosen Rahmen bleibt.

1. **R2 → Bucket erstellen**, Name `draftboard-vods`.
2. Worker → **Einstellungen → Bindungen → Hinzufügen → R2-Bucket**: Variablenname `VODS`, Bucket `draftboard-vods`.
3. Worker → **Variablen und Geheimnisse**: Typ **Geheimnis**, Name `UPLOAD_KEY`, Wert = ein Upload-Passwort.
4. Die neue [`worker.js`](worker.js) (Version 5) bereitstellen.
5. Im Board: **Einstellungen → Riot → Video-Upload** das Passwort eintragen und **Speichern & prüfen** klicken.

Mit der Kommandozeile: `wrangler r2 bucket create draftboard-vods`, dann in `wrangler.toml` den
`[[r2_buckets]]`-Block aktivieren, `wrangler secret put UPLOAD_KEY` ausführen und `wrangler deploy`.

Hinweise:

- Hochladen darf nur, wer das Upload-Passwort kennt. Ansehen kann jeder, der den Link aus dem Board hat
  (die Dateinamen sind zufällig und nicht erratbar).
- Große Dateien werden in Teilen zu je 24 MB hochgeladen. Die Seite muss offen bleiben, bis der Upload fertig ist.
- **MP4 (H.264)** läuft in jedem Browser. 10 GB reichen für etwa 10 bis 20 Spiele in 720p.
  OBS-Tipp: 720p, 30 fps und etwa 4000 kbit/s ergeben pro Spiel rund 1 GB.
- **Speicher-Grenze** (Einstellungen → Riot → Video-Upload): Bei „10 GB – kostenlos bleiben“ bietet das Board vor einem Upload,
  der nicht mehr passt, an, die ältesten Videos zu löschen (Notizen und Zeitmarken der Spiele bleiben). Größere Grenzen kosten
  bei R2 etwa 1,5 Cent pro GB und Monat; Abspielen ist immer kostenlos. Dort gibt es auch eine Liste aller Videos zum Löschen
  (braucht `worker.js` ab Version 9).
- Wenn ihr ein VOD im Board entfernt, wird auch die Datei gelöscht (bei dem, der das Upload-Passwort eingetragen hat).
- Ohne Einrichtung geht immer **„Nur hier abspielen“**: Die Datei läuft dann nur auf diesem Gerät, ohne Upload.
