#!/bin/sh
# Macht alle vorhandenen Team-Agenten sprechfähig (Modell + Provider). Im hermes-agent-Container ausführen.
for p in mira nina jonas tanja peter lars sophia tom max; do
  hermes profile show "$p" >/dev/null 2>&1 || continue
  hermes -p "$p" config set model.default claude-sonnet-4-6 >/dev/null 2>&1
  hermes -p "$p" config set model.provider anthropic >/dev/null 2>&1
  cur=$(hermes -p "$p" model 2>&1 | grep -i 'current model' | sed 's/^[[:space:]]*//')
  echo "OK $p -> $cur"
done
echo "SETUP FERTIG"
