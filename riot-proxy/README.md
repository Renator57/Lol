# Riot-Proxy für das Draft Board

Das Board lädt unter **Gegner-Picks → „Matchdaten laden“** die echten letzten Spiele der Gegner:
meistgespielte Champions mit Spielen, Winrate und KDA, den Rang (Solo/Duo), die Formkurve
der letzten Spiele und eine Warnung, wenn jemand meist eine andere Rolle spielt.

Die Riot-API darf nicht direkt aus dem Browser aufgerufen werden (CORS), und der API-Key
darf nicht in der öffentlichen `index.html` stehen. Deshalb läuft dazwischen dieser kleine
Cloudflare Worker. Er ist kostenlos (100.000 Aufrufe/Tag) und hält den Key geheim.

## 1. Riot-API-Key holen

1. Auf <https://developer.riotgames.com> mit dem Riot-Account einloggen.
2. Im Dashboard steht ein **Development API Key**. Der läuft nach **24 Stunden** ab und reicht zum Ausprobieren.
3. Für dauerhaft: **„Register Product“ → „Personal API Key“** beantragen (kurze Beschreibung,
   z. B. „Scouting-Tool für unser Prime-League-Team, nur interne Nutzung“). Der Key läuft nicht ab.

## 2. Worker deployen

### Variante A: im Browser (ohne Installation)

1. Bei <https://dash.cloudflare.com> anmelden (kostenloser Account).
2. **Workers & Pages → Erstellen → Worker erstellen**, Name z. B. `draftboard-riot`, **Bereitstellen**.
3. **Code bearbeiten**, den Inhalt von [`worker.js`](worker.js) komplett einfügen, **Bereitstellen**.
4. **Einstellungen → Variablen und Geheimnisse → Hinzufügen**:
   - Typ **Geheimnis**, Name `RIOT_API_KEY`, Wert = euer Riot-Key.
   - Optional Typ **Text**, Name `ALLOWED_ORIGINS`, Wert = Adresse eures Boards
     (z. B. `https://deinname.github.io`). Dann darf nur euer Board den Proxy benutzen.
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

## Limits

- Pro Spieler braucht der Proxy etwa *Anzahl Spiele + 3* Riot-Aufrufe. Ein Development-Key erlaubt
  100 Aufrufe in 2 Minuten. Mit 15 Spielen passt also ein ganzes Team. Bei 30 Spielen kann
  „Riot-Limit erreicht“ kommen. Dann kurz warten und die fehlenden Spieler mit **Neu laden** nachholen.
- Match-Details werden 30 Tage im Worker zwischengespeichert, fertige Auswertungen 10 Minuten.
  Erneutes Laden kostet deshalb kaum Aufrufe.
- „API-Key ungültig oder abgelaufen“ bedeutet beim Development-Key meistens, dass die 24 Stunden um sind.
  Dann den neuen Key als `RIOT_API_KEY` eintragen.
