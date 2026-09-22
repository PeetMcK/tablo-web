#!/usr/bin/env bash
# Is the running stack the one we mean to run?
#
# The app is a host backend plus a containerized frontend, and the way it goes
# wrong is silent: the page still loads, the guide still fills, and nothing in
# the UI says you are talking to a different backend with a different database.
# So this asks the questions the UI cannot answer.
#
# Exit 0 when the stack is correct, 1 when it is not. Every failure prints what
# it found and what to do about it.
set -uo pipefail

FRONTEND="${TABLO_FRONTEND_CONTAINER:-tablo-web-frontend-1}"
BACKEND_CONTAINER="${TABLO_BACKEND_CONTAINER:-tablo-web-backend-1}"
PORT="${TABLO_PORT:-7070}"
API_PORT="${TABLO_API_PORT:-8000}"

fails=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fails=$((fails + 1)); }
note() { printf '        %s\n' "$1"; }

echo "tablo-web stack"
echo

# ---------------------------------------------------------------- the backend
# The host process is the whole point of this arrangement: VideoToolbox is a
# macOS framework, so only a process on the host can encode in hardware.
listener=$(lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}')
if [ -z "$listener" ]; then
  bad "nothing is listening on :$API_PORT"
  note "start it with: backend/run-native.sh"
else
  cmd=$(ps -p "$listener" -o command= 2>/dev/null)
  case "$cmd" in
    *backend/.venv/bin/uvicorn*|*.venv/bin/uvicorn*)
      ok "native backend on :$API_PORT (pid $listener)" ;;
    *)
      bad "something else holds :$API_PORT (pid $listener)"
      note "$cmd" ;;
  esac
fi

# ------------------------------------------------- the frontend's proxy target
# This is the check that matters. nginx is told where the API lives at container
# start, so a frontend recreated without docker-compose.native.yml points at the
# container backend instead - and says nothing about it.
if ! docker inspect "$FRONTEND" >/dev/null 2>&1; then
  bad "no $FRONTEND container"
  note "see SKILL.md: Starting it"
else
  origin=$(docker inspect "$FRONTEND" --format \
    '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^BACKEND_ORIGIN=' | cut -d= -f2-)
  case "$origin" in
    host.docker.internal:*)
      ok "frontend proxies to the host ($origin)" ;;
    "")
      bad "frontend has no BACKEND_ORIGIN"
      note "recreate it with all three compose files" ;;
    *)
      bad "frontend proxies to $origin, not the host"
      note "it was recreated without docker-compose.native.yml, so the app you"
      note "are looking at is served by the container backend: a different"
      note "database, and no hardware encoding. See SKILL.md: Putting it right." ;;
  esac

# ------------------------------------------------------- is it the built image
# `docker compose up -d` after a build often reports "Running" and changes
# nothing: the tag is the same, the service config is the same, so compose sees
# no reason to recreate - and the container keeps serving the image it started
# with. The build succeeds, the page looks fine, and the change is not there.
  running_image=$(docker inspect "$FRONTEND" --format '{{.Image}}' 2>/dev/null)
  tagged_image=$(docker image inspect tablo-web-frontend:local --format '{{.Id}}' 2>/dev/null)
  if [ -n "$tagged_image" ] && [ "$running_image" != "$tagged_image" ]; then
    bad "frontend container is older than the image that was last built"
    note "recreate it: docker compose up -d --force-recreate frontend"
  elif [ -n "$tagged_image" ]; then
    ok "frontend runs the image that was last built"
  fi

# And is the image itself newer than the code it should contain?
#
# "Runs the image last built" was true and was not the question. The frontend
# Dockerfile ends in `COPY . .` and `npm run build`, and a cached COPY layer
# will happily rebuild an image out of source that predates the change being
# deployed. The tag moves, the container is recreated, this check passed, and
# the served bundle was old - three deploys went out that way before anyone
# searched the served JavaScript for a string it should have contained.
#
# Against the last commit that touched the frontend, because that is what a
# deploy is made of. Uncommitted work is not covered and does not need to be:
# it is not what anybody thinks they shipped.
  built_at=$(docker image inspect tablo-web-frontend:local \
    --format '{{.Created}}' 2>/dev/null)
  # Docker reports UTC, and parsed as local time it lands hours in the future -
  # where nothing is ever newer than it. Which is how the first version of this
  # check waved through an image that was deliberately stale, twice.
  built_epoch=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${built_at%%.*}" +%s 2>/dev/null)
  source_epoch=$(git log -1 --format=%ct -- frontend 2>/dev/null)
  if [ -n "${built_epoch:-}" ] && [ -n "${source_epoch:-}" ]; then
    if [ "$source_epoch" -gt "$built_epoch" ]; then
      bad "frontend image predates the last commit to frontend/"
      note "image built $(TZ=UTC date -r "$built_epoch" '+%Y-%m-%d %H:%M:%SZ')"
      note "code committed $(TZ=UTC date -r "$source_epoch" '+%Y-%m-%d %H:%M:%SZ')"
      note "rebuild it: docker compose build frontend"
      note "and if a cached layer is the reason, add --no-cache"
    else
      ok "frontend image is newer than the last frontend commit"
    fi
  fi
fi

# --------------------------------------------------------- the stray container
# Harmless on its own, but it is the tell that the native overlay was missed,
# and it holds a second copy of the data in a docker volume.
if docker inspect "$BACKEND_CONTAINER" >/dev/null 2>&1; then
  bad "$BACKEND_CONTAINER is running"
  note "the native overlay disables this service; its presence means a compose"
  note "command ran without docker-compose.native.yml"
else
  ok "no container backend (the host process is the backend)"
fi

# ----------------------------------------------------------------- end to end
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)
[ "$code" = "200" ] && ok "app answers on :$PORT" || bad "app returned $code on :$PORT"

code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/channels" 2>/dev/null)
case "$code" in
  200) ok "API answers through the proxy" ;;
  401) ok "API answers through the proxy (401: not signed in)" ;;
  *)   bad "API returned $code through the proxy" ;;
esac

echo
if [ "$fails" -eq 0 ]; then
  echo "Stack is correct."
else
  echo "$fails problem(s). See .claude/skills/tablo-stack/SKILL.md"
fi
exit $(( fails > 0 ))
