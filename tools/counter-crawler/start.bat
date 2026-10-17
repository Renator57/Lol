@echo off
REM Counter-Crawler starten (Windows). RIOT_API_KEY in die Datei .env schreiben: RIOT_API_KEY=RGAPI-...
cd /d "%~dp0"
python crawl.py %*
echo.
echo Fertig. Die Datei counters.json im Board unter "Matchups" -> "Counter-Daten laden" einlesen.
pause
