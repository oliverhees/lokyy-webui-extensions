#!/bin/sh
# Im hermes-agent-Container ausfuehren. Prueft: Redeploy-Mount + ob der Task Daten erzeugte.
echo "=== 1) /workspace im Agent gemountet? (= neue Compose aktiv) ==="
if [ -d /workspace ]; then
  echo "OK: /workspace existiert"
  ls -la /workspace 2>/dev/null
else
  echo "FEHLT: /workspace nicht da -> Compose-Redeploy noch nicht aktiv!"
fi
echo ""
echo "=== 2) research/ vom Task erzeugt? ==="
ls -la /workspace/research 2>/dev/null || echo "(noch kein research/ - Task evtl. noch nicht getickt)"
echo "--- daten/ ---"
ls -la /workspace/research/daten 2>/dev/null
echo ""
echo "=== 3) schema.json (der Vertrag) ==="
cat /workspace/research/schema.json 2>/dev/null || echo "(noch keine schema.json)"
echo ""
echo "=== 4) heutiger Datensatz ==="
cat /workspace/research/daten/2026-06-03.json 2>/dev/null || echo "(noch keine Daten fuer heute)"
echo ""
echo "VERIFY FERTIG"
