#!/bin/sh
# ChimaTrader (QianYiSuo) portable launcher for Linux x86_64 / arm64.
# The bundled runtime is Node 16.20.2 (glibc >= 2.17), so no system Node.js
# installation is needed. Data lives in ./data and is saved automatically.

set -u

cd "$(dirname "$0")" || exit 1

APP_PORT="${PORT:-8787}"
OPEN_BROWSER=1

usage() {
  echo "Usage: ./start.sh [--no-browser] [--port N]"
  echo "  --no-browser   do not try to open a browser"
  echo "  --port N       listen on N instead of 8787 (or set PORT in the environment)"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-browser) OPEN_BROWSER=0; shift ;;
    --port)
      if [ "$#" -lt 2 ]; then
        echo "[ERROR] --port needs a value" >&2
        exit 2
      fi
      APP_PORT="$2"; shift 2 ;;
    --port=*) APP_PORT="${1#--port=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[ERROR] unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$APP_PORT" in
  ''|*[!0-9]*) echo "[ERROR] invalid port: $APP_PORT" >&2; exit 2 ;;
esac

APP_URL="http://127.0.0.1:$APP_PORT"

echo "ChimaTrader (QianYiSuo) - portable edition"
echo "Starting the server ..."
echo "Local URL: $APP_URL"
echo "Press Ctrl+C to stop. Data is saved automatically in ./data"
echo

if [ ! -f runtime/bin/node ]; then
  echo "[ERROR] runtime/bin/node is missing - extract the tarball again and keep the folder structure." >&2
  exit 1
fi
[ -x runtime/bin/node ] || chmod +x runtime/bin/node 2>/dev/null || true
if [ ! -x runtime/bin/node ]; then
  echo "[ERROR] runtime/bin/node is not executable. Run 'chmod +x runtime/bin/node start.sh' or extract" >&2
  echo "        the tarball with a tool that preserves permissions (tar -xzf ...)." >&2
  exit 1
fi

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q ":$APP_PORT "
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -q ":$APP_PORT "
    return $?
  fi
  return 1
}

if port_in_use; then
  echo "[ERROR] Port $APP_PORT is already in use." >&2
  echo "        Close the other ChimaTrader instance, or run: PORT=8799 ./start.sh" >&2
  exit 1
fi

if [ "$OPEN_BROWSER" = 1 ]; then
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
    ( sleep 2; xdg-open "$APP_URL" >/dev/null 2>&1 ) &
  else
    echo "Open $APP_URL in your browser (rerun with --no-browser to skip the browser hint)."
    echo
  fi
fi

exec ./runtime/bin/node app.mjs
