@echo off
REM Nightly regeneration of analysis/ reports (dead-code, knip, eslint, health, etc.)
REM so cached snapshots never go silently stale again. See 2026-07-27 incident:
REM a 10-day-old analysis/reports/dead-code-report.md was cited as current evidence
REM for a navigation audit, reporting files that had since been deleted from the app.
cd /d "C:\Users\malar\OneDrive\Desktop\Pulse_WORKING"
call npm run analyze >> "C:\Users\malar\OneDrive\Desktop\Pulse_WORKING\analysis\logs\scheduled-run.log" 2>&1
