#!/usr/bin/env bash
# Validation complète : syntaxe JS (node --check) + les 16 suites smoke.
#
# Usage :
#   npm run check          # lance tout ; le serveur dev est démarré
#                          # (si le port 8000 est libre) puis arrêté
#
# Ordre :
#   1. node --check sur tous les fichiers JS (l'app est en ES modules ;
#      depuis Node 24 la détection automatique du type de module est
#      activée par défaut — le flag --experimental-default-type=module,
#      obligatoire sous Node 18, a disparu de Node 24) + les scripts smoke.
#   2. npm run smoke (les 16 suites headless).
#
# Serveur : on réutilise un serveur déjà actif sur :8000 (probe curl
# -sf = échec sur HTTP ≥ 400, pour ne pas confondre un autre service),
# sinon on démarre python3 test_server.py et on l'arrête par PID (pas
# de pkill par nom : le wrapper bash matcherait son propre cmdline).
# Un trap nettoie le serveur même si le script est interrompu (Ctrl+C).

set -u
cd "$(dirname "$0")/.." || { echo 'check : répertoire du projet introuvable.'; exit 1; }

echo '=== 1/2 Syntaxe JS (node --check) ==='
fail=0
# Racine : app ES modules (main.js, editor.js, draw.js, …) — Node 24
# auto-détecte la syntaxe ESM dans --check, aucun flag requis.
for f in *.js; do
    node --check "$f" >/dev/null 2>&1 || {
        echo "SYNTAX FAIL: $f"
        fail=1
    }
done
# scripts : *.mjs = ESM par extension ; strip-narrative.js = CJS
for f in scripts/*.mjs scripts/strip-narrative.js; do
    node --check "$f" >/dev/null 2>&1 || {
        echo "SYNTAX FAIL: $f"
        fail=1
    }
done
if [ "$fail" -eq 1 ]; then
    echo 'ÉCHEC syntaxe.'
    exit 1
fi
echo 'Syntaxe OK'

echo '=== 2/2 Suites smoke (npm run smoke) ==='
server_started=0
SRV=''
cleanup() {
    if [ "$server_started" -eq 1 ] && [ -n "$SRV" ]; then
        kill "$SRV" 2>/dev/null
        wait "$SRV" 2>/dev/null
    fi
}
trap cleanup EXIT INT TERM

server_probe() {
    curl -sf -o /dev/null --max-time 2 http://localhost:8000/main.html
}

if server_probe; then
    echo 'Serveur dev déjà actif sur :8000 — réutilisé.'
else
    echo 'Démarrage de python3 test_server.py …'
    python3 test_server.py > /tmp/meshes_server.log 2>&1 &
    SRV=$!
    server_started=1
    # Attente de disponibilité (jusqu'à ~5 s) avant de lancer les suites.
    ready=0
    for _ in 1 2 3 4 5; do
        sleep 1
        if server_probe; then ready=1; break; fi
    done
    if [ "$ready" -ne 1 ]; then
        echo "check : le serveur dev n'a pas démarré (voir /tmp/meshes_server.log)."
        exit 1
    fi
fi

npm run smoke
rc=$?

if [ "$rc" -eq 0 ]; then
    echo 'check : TOUT EST VERT.'
else
    echo "check : ÉCHEC (npm run smoke, exit $rc)."
fi
exit "$rc"
