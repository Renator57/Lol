@echo off
REM ============================================================
REM  Counter-Crawler fuer das Draft Board
REM  - Doppelklick: sucht 10 Stunden in allen Ligen UEBER Gold
REM    (Platin, Smaragd, Diamant, Master, Grandmaster, Challenger)
REM  - Baut immer auf dem Vorhandenen auf (crawl.db), setzt nie zurueck.
REM    Strg+C haelt an und speichert; naechster Start macht weiter.
REM  - RIOT_API_KEY vorher in die Datei .env schreiben:  RIOT_API_KEY=RGAPI-...
REM  - Komplett neu anfangen:  start.bat --neu
REM ============================================================
cd /d "%~dp0"
python crawl.py --stunden 10 --ligen challenger,grandmaster,master,diamond,emerald,platinum %*
echo.
echo Fertig. Die Datei counters.json im Board unter "Matchups" -^> "Counter-Daten laden" einlesen.
pause
