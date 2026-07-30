import errno
import http.server
import socket
import socketserver
import sys
import threading

PORT = 8000

# Handler custom : on surcharge end_headers pour envoyer
# Cache-Control: no-store sur CHAQUE reponse. Justification :
# python -m http.server (SimpleHTTPRequestHandler) n'envoie
# AUCUN Cache-Control par defaut. Resultat : le navigateur peut
# conserver en cache disque les modules ES (viewport.js, editor.js,
# etc.) qui sont importes via <script type="module" src="...">.
# Quand on modifie un module, un Ctrl+R simple sert souvent
# l'ancienne version du cache disque, et le navigateur execute
# du code perime (typiquement : ReferenceError sur une fonction
# qui n'existait pas avant la modif).
#
# no-store = revalidation obligatoire a chaque hit. no-cache
# seul laisse le navigateur revalider mais peut quand meme
# servir du contenu stale si la revalidation est partielle.
# no-store garantit l'absence totale de cache disque ou
# memoire, ce qui correspond exactement a ce qu'on veut pour
# un serveur de dev sans build step. Cout : ~0ms (1 header
# ajoute par reponse, jamais reellement cache).
#
# En prod derriere un vrai serveur (nginx, Apache, etc.) on
# remplacerait ca par du cache immutable + content-hash ; pas
# applicable ici puisque le projet est 100% dev local.
class NoCacheRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

# Évènement positionné par le thread daemon UNE FOIS le bind() réussi.
# Le main thread l'attend avec un timeout borné : si l'évènement n'est
# pas set dans les 2 s, c'est que start_server() a planté (port déjà
# occupé, permission refusée, etc.) — auquel cas on sort en erreur
# au lieu d'imprimer un menteur "Server should be running".
_server_ready = threading.Event()
# Exception capturée depuis le thread daemon si le bind échoue.
# Verrouillée pour éviter une race sur la lecture/écriture entre
# les deux threads.
_server_error = None
_server_error_lock = threading.Lock()


def start_server():
    """Lance le TCPServer dans le thread daemon. En cas d'échec de
    bind() (ex: EADDRINUSE), stocke l'exception dans _server_error et
    retourne sans imprimer 'serving at port' — le main thread la lira."""
    global _server_error
    try:
        # Disable allow_reuse_address to avoid TIME_WAIT races on hot reload
        class _ReuseTCPServer(socketserver.TCPServer):
            allow_reuse_address = True
        httpd = _ReuseTCPServer(
            ("", PORT), NoCacheRequestHandler
        )
    except OSError as e:
        with _server_error_lock:
            _server_error = e
        return
    print(f"serving at port {PORT} (Cache-Control: no-store)", flush=True)
    _server_ready.set()
    httpd.serve_forever()


def _report_startup_failure_and_exit(reason):
    """Affiche un diagnostic lisible et termine le script avec un code
    d'erreur. Utilisé dans tous les chemins où le serveur N'EST PAS
    réellement en écoute."""
    with _server_error_lock:
        err = _server_error
    if isinstance(err, OSError) and err.errno == errno.EADDRINUSE:
        detail = f"port {PORT} déjà utilisé par un autre processus"
    elif err is not None:
        detail = str(err)
    else:
        detail = reason
    print(f"Server NOT running: {detail}", flush=True)
    sys.exit(1)


t = threading.Thread(target=start_server, daemon=True)
t.start()

# Attente bornée (2 s) : si le thread n'a pas signalé _server_ready
# dans ce délai, le bind a probablement échoué.
if not _server_ready.wait(timeout=2):
    _report_startup_failure_and_exit("le thread daemon n'a pas démarré dans le délai")

# Double-check : on confirme que le port répond vraiment. Le bind() du
# TCPServer peut réussir sans que la connexion soit immédiatement
# acceptée (rare mais possible, ex: firewall local). Si create_connection
# échoue, on sort en erreur plutôt que d'imprimer "Server is running".
try:
    with socket.create_connection(("127.0.0.1", PORT), timeout=1):
        pass
except OSError as e:
    _report_startup_failure_and_exit(f"port {PORT} bind mais pas accessible: {e}")

print(
    f"Server is running on http://localhost:{PORT}/  (Ctrl-C pour arrêter)",
    flush=True,
)

# Keep-alive : si le main thread sort ici, Python termine le programme
# et le thread daemon (serveur) meurt avec lui — coupant net toutes
# les connexions. threading.Event().wait() bloque jusqu'à Ctrl-C
# (KeyboardInterrupt) sans busy-loop, et reste portable POSIX/Windows.
try:
    threading.Event().wait()
except KeyboardInterrupt:
    pass
print("Server stopped", flush=True)
