#!/bin/bash
# Manages the "patate" Docker container.
#
# Usage:
#   ./server_patate.sh [option]
#
# Options:
#   (no option)       Start the container in detached mode.
#   -it               Start the container in interactive mode.
#   -s                Stop the container.
#   -r                Restart the container (e.g. after changing the password in .env).
#   -b                Build (or rebuild) the image from the Dockerfile next to this script.
#                     Run it once before the first start, and after each `git pull`.
#
# The app listens on port 6767 in the container, published on 127.0.0.1:$HOST_PORT only
# (8090 by default): Apache is the only thing exposed to the outside and proxies to it.
# Volumes (kept on the host, so they survive the --rm containers):
#   - $HOST_DATA_DIR -> $APP_DIR/data   (custom packs + session key data/secret_key)
#   - $ENV_FILE      -> $APP_DIR/.env   (read-only: PATATE_PASSWORD, never copied into the image)
#
# The container runs with the host user's UID/GID, so the files in data/ stay owned by you.
#
# Logs: everything the container prints is appended to one file per day, $LOG_DIR/YYYY-MM-DD.log
# (logs/ next to this script, git-ignored), each line prefixed with its time, until the container stops.

CONTAINER_NAME="patate"
IMAGE="patate:latest"

# Working directory of the image (where app.py, patate/ and data/ live).
APP_DIR="/app"

# Host folders, next to this script by default (override with environment variables).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DATA_DIR="${HOST_DATA_DIR:-$SCRIPT_DIR/data}"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/logs}"
HOST_PORT="${HOST_PORT:-8090}"

# Created here, not by Docker: Docker would create missing folders owned by root.
mkdir -p "$HOST_DATA_DIR" "$LOG_DIR"

# The password lives in .env (never in the image). Without it the Settings stay closed:
# create it from the template and say so, instead of failing silently.
if [ ! -f "$ENV_FILE" ]; then
    (umask 077 && printf '# Mot de passe des Settings (packs). Vide = Settings fermés.\nPATATE_PASSWORD=\n' > "$ENV_FILE")
    echo "Created $ENV_FILE: set PATATE_PASSWORD in it, then run ./server_patate.sh -r"
fi
if ! grep -Eq '^[[:space:]]*PATATE_PASSWORD[[:space:]]*=[[:space:]]*[^[:space:]#]' "$ENV_FILE"; then
    echo "Warning: PATATE_PASSWORD is empty in $ENV_FILE, the Settings (packs) will stay closed."
fi

VOLUMES=(
    -v "$HOST_DATA_DIR:$APP_DIR/data"
    -v "$ENV_FILE:$APP_DIR/.env:ro"
)

# Same UID/GID as the host user (files in data/ stay yours); PATATE_DATA_DIR is forced to the
# mounted folder, whatever .env says (a real environment variable wins over the .env file).
RUN_OPTS=(
    --rm --name "$CONTAINER_NAME"
    -p "127.0.0.1:$HOST_PORT:6767"
    --user "$(id -u):$(id -g)"
    -e PATATE_DATA_DIR="$APP_DIR/data"
    "${VOLUMES[@]}"
)

# Reads log lines on stdin and appends each one to the file of the current day ($LOG_DIR/YYYY-MM-DD.log),
# so a new file starts at midnight without restarting anything. --tee also prints the lines on the terminal.
write_daily_logs() {
    local line now
    while IFS= read -r line || [ -n "$line" ]; do
        printf -v now '%(%F %T)T' -1    # bash builtin: no `date` process per line
        printf '%s %s\n' "${now#* }" "$line" >> "$LOG_DIR/${now%% *}.log"
        [ "$1" = "--tee" ] && printf '%s\n' "$line"
    done
}

build_image() {
    sudo docker build -t "$IMAGE" "$SCRIPT_DIR"
}

start_detached() {
    sudo docker run -d "${RUN_OPTS[@]}" "$IMAGE" || return
    # Copies the container's output into the daily log files in the background; stops by itself with the container.
    # sudo -n: never waits for a password in the background (the run above just asked for it).
    # trap '' HUP: keeps running after the terminal is closed (what nohup did before).
    (trap '' HUP; sudo -n docker logs -f "$CONTAINER_NAME" 2>&1 | write_daily_logs) </dev/null >/dev/null 2>&1 &
    echo "Patate: http://127.0.0.1:$HOST_PORT  (logs: $LOG_DIR/$(date +%F).log)"
}

start_interactive() {
    sudo docker run -it "${RUN_OPTS[@]}" "$IMAGE" 2>&1 | write_daily_logs --tee
}

stop_container() {
    sudo docker stop "$CONTAINER_NAME"
}

restart_container() {
    stop_container
    start_detached
}

case "$1" in
    -it)
        start_interactive
        ;;
    -s)
        stop_container
        ;;
    -r)
        restart_container
        ;;
    -b)
        build_image
        ;;
    *)
        start_detached
        ;;
esac
