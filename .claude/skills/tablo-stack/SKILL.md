---
name: tablo-stack
description: How to start, restart, rebuild and verify the tablo-web app - a native macOS backend plus a containerized frontend. Use this skill whenever you are about to run docker compose in this repo, start or restart the app, rebuild the frontend after a code change, deploy or "apply" changes so they show up at 127.0.0.1:7070, or investigate why the app behaves oddly (missing recordings, signed out, slow transcodes, changes not appearing). Also use it before telling the user the app is running correctly - a bare `docker compose up` silently serves the app from the wrong backend, and nothing in the UI says so.
---

# Running tablo-web

The app is two halves that are easy to get wrong together:

- **The backend runs on the host**, from `backend/run-native.sh`, on `127.0.0.1:8000`.
- **The frontend runs in a container**, nginx on `127.0.0.1:7070`, proxying `/api`
  to the host backend.

The backend is on the host because VideoToolbox is a macOS framework and Docker
Desktop runs a Linux VM with no passthrough. Measured on one 60s window:
CPU 47.4s → 5.1s, output 30 MB → 22 MB. That is the entire reason for the split,
and it is why "just run it all in Docker" is not a simplification.

## Starting it

Three compose files, every time:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.override.yml \
  -f docker-compose.native.yml \
  up -d frontend

backend/run-native.sh          # foreground; leave it running
```

What each file contributes: `docker-compose.yml` is the shape of the stack;
`docker-compose.override.yml` (gitignored, local) builds from this checkout
instead of pulling GHCR images; `docker-compose.native.yml` disables the backend
service and points the frontend at `host.docker.internal:8000`.

**Set `COMPOSE_FILE` once and stop thinking about it.** Copy `.env.example` to
`.env` in the repo root and every bare `docker compose` command in this
directory picks up all three files:

```bash
cp .env.example .env
```

That is the durable fix. The instructions below assume you have not done it yet.

## The failure mode

`docker compose up -d frontend`, with no `-f` flags, loads `docker-compose.yml`
and `docker-compose.override.yml` — but **not** the native overlay. Two things
happen at once:

1. The `backend` service is no longer disabled, so a **container backend starts**.
2. The frontend is recreated with `BACKEND_ORIGIN=backend:8000`, so **nginx
   proxies to that container** instead of to the host.

Nothing fails. The page loads, the guide fills, recordings list. You are simply
looking at a different application: a different database (the `tablo-web_data`
volume rather than `~/Library/Application Support/tablo-web`), different device
tokens, a different transcode cache, and no hardware encoding. The host backend
keeps running, untouched and unused.

This is worth being pedantic about because the symptoms arrive later and look
like bugs: recordings that "disappeared", a login that "was lost", transcodes
that got slow. Someone then debugs the app instead of the stack.

The same trap catches `docker compose build frontend` followed by `up -d`, and
`docker compose restart`. Any compose command that recreates the frontend needs
all three files.

## Verifying it

```bash
.claude/skills/tablo-stack/check-stack.sh
```

It checks what the UI cannot tell you:

- `:8000` is held by `backend/.venv/bin/uvicorn`, not something else
- the frontend's `BACKEND_ORIGIN` is `host.docker.internal:8000`
- no `tablo-web-backend-1` container exists
- the app and the API both answer through the proxy

Exit code 0 means correct. Run it after any compose command, and before telling
anyone the app is running — "it loads" is not evidence that it loads from the
right place.

## Putting it right

If the checker reports the wrong proxy target or a stray container:

```bash
docker rm -f tablo-web-backend-1
docker compose -f docker-compose.yml -f docker-compose.override.yml \
  -f docker-compose.native.yml up -d frontend
.claude/skills/tablo-stack/check-stack.sh
```

Removing the container does not touch the `tablo-web_data` volume, so anything
that accumulated in it while the stack was wrong is still there if you need it.

## Rebuilding after a change

Frontend changes are baked into the image at build time — the running container
serves whatever was built, so editing files or pulling `main` changes nothing
until you rebuild:

```bash
docker compose build frontend
docker compose up -d --force-recreate frontend
.claude/skills/tablo-stack/check-stack.sh
```

`--force-recreate` is not belt and braces. The image tag does not change between
builds and neither does the service config, so a plain `up -d` after a build
routinely prints `Container tablo-web-frontend-1  Running` and leaves the old
container in place, still serving the previous image. The build succeeded, the
page loads, and your change is simply not there — which sends you looking for a
bug in code that was never shipped. The checker compares the running container's
image against the one last built, so it catches this even if the habit slips.

(Without `.env`, spell out `-f docker-compose.yml -f docker-compose.override.yml
-f docker-compose.native.yml` on both commands.)

To confirm the new build is the one being served, the bundle name changes:

```bash
curl -s http://127.0.0.1:7070/ | grep -o 'index-[A-Za-z0-9]*\.js'
```

Backend changes need the host process restarted — it does not reload. Stop
`run-native.sh` and start it again; `[state] restored N device(s)` in its output
means it came back with your credentials.

## Where the data lives

`~/Library/Application Support/tablo-web` — config, database, secret key, and
the transcode cache. Deliberately Application Support and not Caches: macOS
purges Caches under disk pressure, which would delete the offline copies that
"keep" promised to preserve. `backend/run-native.sh` documents the environment
variables that move it.
