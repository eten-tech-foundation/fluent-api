#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Runtime detection (prefer native Podman pods) ─────────────────────────────

# ── Variable initialization (required for set -u) ──────────────────────────────

RUNTIME=""
COMPOSE_CMD=""

detect_runtime() {
  if command -v podman &>/dev/null; then
    RUNTIME_MODE="podman-pod"
    RUNTIME="podman"
  elif command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
    RUNTIME_MODE="docker-compose"
    COMPOSE_CMD="docker compose"
  elif command -v docker &>/dev/null && command -v docker-compose &>/dev/null; then
    RUNTIME_MODE="docker-compose"
    COMPOSE_CMD="docker-compose"
  else
    echo "Error: No container runtime found."
    echo "Install one of:"
    echo "  - Podman (native pods)"
    echo "  - Docker Desktop (includes docker compose V2)"
    echo "  - Docker Engine + docker-compose"
    exit 1
  fi
}

detect_runtime

# ── Color helpers ─────────────────────────────────────────────────────────────

YELLOW='\033[1;33m'
GREEN='\033[1;32m'
RED='\033[1;31m'
NC='\033[0m'

echo_running() { echo -e "${YELLOW}>>> $1${NC}"; }
echo_success() { echo -e "${GREEN}>>> $1${NC}"; }
echo_error()   { echo -e "${RED}>>> $1${NC}"; }

# ── Mode derivation (ecosystem vs standalone) ─────────────────────────────────

if [[ -n "${FLUENT_ECOSYSTEM:-}" ]]; then
  POD_NAME="$FLUENT_POD_NAME"
  CONTAINER_PREFIX="$FLUENT_CONTAINER_PREFIX"
  DB_CONTAINER="${CONTAINER_PREFIX}db"
  API_CONTAINER="${CONTAINER_PREFIX}api"
  WORKER_CONTAINER="${CONTAINER_PREFIX}worker"
  PGDATA_VOLUME="${FLUENT_PGDATA_VOLUME:-fluent-pgdata}"
  DB_PORT="${FLUENT_DB_PORT:-5432}"
  API_PORT="${FLUENT_API_PORT:-9999}"
  SKIP_DB=1
else
  POD_NAME="fluent-api"
  CONTAINER_PREFIX="fluent-api-"
  DB_CONTAINER="fluent-api-db"
  API_CONTAINER="fluent-api-api"
  WORKER_CONTAINER="fluent-api-worker"
  PGDATA_VOLUME="fluent-api-pgdata"
  DB_PORT="${DB_PORT:-5432}"
  API_PORT="${API_PORT:-9999}"
  SKIP_DB=0
fi

# ── Podman volume / pod management ───────────────────────────────────────────

pod_create() {
  if $RUNTIME pod exists "$POD_NAME" 2>/dev/null; then
    echo_success "Pod $POD_NAME already exists"
    return
  fi
  echo_running "Creating pod $POD_NAME..."
  $RUNTIME pod create \
    --name "$POD_NAME" \
    --share "net,ipc,uts" \
    -p "${DB_PORT}:5432" \
    -p "${API_PORT}:9999"
}

pod_destroy() {
  if $RUNTIME pod exists "$POD_NAME" 2>/dev/null; then
    echo_running "Removing pod $POD_NAME..."
    $RUNTIME pod rm "$POD_NAME" -f
  fi
}

create_volumes() {
  echo_running "Creating volumes..."
  $RUNTIME volume create $PGDATA_VOLUME 2>/dev/null || true
}

wait_for_db() {
  echo_running "Waiting for database to be ready..."
  while ! $RUNTIME exec $DB_CONTAINER pg_isready -U postgres -d fluent 2>/dev/null; do
    sleep 2
  done
  echo_success "Database is ready"
}

wait_for_api() {
  echo_running "Waiting for API to be ready..."
  local retries=30
  while [ "$retries" -gt 0 ]; do
    if $RUNTIME exec $API_CONTAINER curl -sf http://localhost:9999/health 2>/dev/null; then
      echo_success "API is ready"
      return
    fi
    retries=$((retries - 1))
    echo -n "."
    sleep 3
  done
  echo ""
  echo_error "API did not become healthy in time"
  exit 1
}

# ── Podman container start functions ──────────────────────────────────────────

start_db_container() {
  if $RUNTIME container exists $DB_CONTAINER 2>/dev/null; then
    echo_success "Database container already exists"
    return
  fi
  echo_running "Starting database container..."
  $RUNTIME run -d \
    --name $DB_CONTAINER \
    --pod "$POD_NAME" \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=fluent \
    -v $PGDATA_VOLUME:/var/lib/postgresql/data \
    -v "$SCRIPT_DIR/db/init:/docker-entrypoint-initdb.d:ro" \
    --health-cmd "pg_isready -U postgres -d fluent" \
    --health-interval 5s \
    --health-timeout 5s \
    --health-retries 5 \
    docker.io/postgres:16-alpine
  echo_success "Database container started"
}

start_api_container() {
  if $RUNTIME container exists $API_CONTAINER 2>/dev/null; then
    echo_success "API container already exists"
    return
  fi

  echo_running "Building API image..."
  $RUNTIME build -t fluent-api "$SCRIPT_DIR" -f Dockerfile.dev

  local -a env_flags=(
    -e "NODE_ENV=development"
    -e "DATABASE_URL=postgres://postgres:postgres@localhost:5432/fluent"
    -e "EXPORTS_DIR=/app/exports"
  )
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    env_flags+=(--env-file "$SCRIPT_DIR/.env")
  fi

  echo_running "Starting API container..."
  $RUNTIME run -d \
    --name $API_CONTAINER \
    --pod "$POD_NAME" \
    "${env_flags[@]}" \
    -v "$SCRIPT_DIR/src:/app/src:ro" \
    -v "$SCRIPT_DIR/tsconfig.json:/app/tsconfig.json:ro" \
    -v "$SCRIPT_DIR/drizzle.config.ts:/app/drizzle.config.ts:ro" \
    -v "$SCRIPT_DIR/docker-entrypoint.sh:/app/docker-entrypoint.sh:ro" \
    --tmpfs /tmp:noexec,nosuid,size=64m \
    --tmpfs /app/.cache:noexec,nosuid,size=128m \
    --tmpfs /app/exports:noexec,nosuid,size=256m \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --user 1001:1001 \
    --read-only \
    fluent-api
  echo_success "API container started"
}

start_worker_container() {
  if $RUNTIME container exists $WORKER_CONTAINER 2>/dev/null; then
    echo_success "Worker container already exists"
    return
  fi

  local -a env_flags=(
    -e "NODE_ENV=development"
    -e "DATABASE_URL=postgres://postgres:postgres@localhost:5432/fluent"
    -e "EXPORTS_DIR=/app/exports"
  )
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    env_flags+=(--env-file "$SCRIPT_DIR/.env")
  fi

  echo_running "Starting worker container..."
  $RUNTIME run -d \
    --name $WORKER_CONTAINER \
    --pod "$POD_NAME" \
    "${env_flags[@]}" \
    -v "$SCRIPT_DIR/src:/app/src:ro" \
    -v "$SCRIPT_DIR/tsconfig.json:/app/tsconfig.json:ro" \
    --tmpfs /tmp:noexec,nosuid,size=64m \
    --tmpfs /app/.cache:noexec,nosuid,size=128m \
    --tmpfs /app/exports:noexec,nosuid,size=256m \
    --security-opt no-new-privileges:true \
    --cap-drop ALL \
    --user 1001:1001 \
    --read-only \
    fluent-api \
    npx tsx watch src/workers/standalone-worker.ts
  echo_success "Worker container started"
}

# ── Podman command functions ───────────────────────────────────────────────────

podman_up() {
  local service="${1:-all}"
  case "$service" in
    all)
      if [[ "$SKIP_DB" -eq 0 ]]; then
        create_volumes
        pod_create
        start_db_container
        wait_for_db
      fi
      start_api_container
      wait_for_api
      start_worker_container
      echo_success "All services started!"
      ;;
    db)
      create_volumes
      pod_create
      start_db_container
      echo_success "Database started!"
      ;;
    api)
      pod_create
      start_api_container
      echo_success "API service started!"
      ;;
    worker)
      pod_create
      start_worker_container
      echo_success "Worker started!"
      ;;
    *)
      echo_error "Unknown service: $service (use: db, api, worker, or omit for all)"
      exit 1
      ;;
  esac
}

podman_down() {
  local service="${1:-all}"
  if [ "$service" = "all" ]; then
    pod_destroy
    echo_success "All services stopped."
  else
    echo_running "Stopping $service..."
    $RUNTIME rm -f "${CONTAINER_PREFIX}$service" 2>/dev/null || true
    echo_success "$service stopped."
  fi
}

podman_restart() {
  local service="${1:-all}"
  if [ "$service" = "all" ]; then
    pod_destroy
    podman_up all
  else
    echo_running "Restarting $service..."
    $RUNTIME rm -f "${CONTAINER_PREFIX}$service" 2>/dev/null || true
    case "$service" in
      db)     start_db_container ;;
      api)    start_api_container ;;
      worker) start_worker_container ;;
      *)      echo_error "Unknown service: $service"; exit 1 ;;
    esac
    echo_success "Restarted $service"
  fi
}

podman_logs() {
  local service="${1:-}"
  if [ -z "$service" ]; then
    $RUNTIME pod logs -f "$POD_NAME"
  else
    # Route through pod logs --container to avoid name-resolution bugs
    # in some Podman builds where 'podman logs <hyphenated-name>' fails.
    $RUNTIME pod logs --container "${CONTAINER_PREFIX}$service" -f "$POD_NAME"
  fi
}

podman_status() {
  $RUNTIME pod ps
  if $RUNTIME pod exists "$POD_NAME" 2>/dev/null; then
    echo ""
    echo "Containers in pod $POD_NAME (all states):"
    $RUNTIME ps -a --filter "pod=$POD_NAME"
  fi
}

podman_shell() {
  local service="${1:-api}"
  if [ "$service" = "db" ]; then
    $RUNTIME exec -it $DB_CONTAINER psql -U postgres -d fluent
  else
    $RUNTIME exec -it "${CONTAINER_PREFIX}$service" sh
  fi
}

podman_exec_api() {
  if ! $RUNTIME container exists $API_CONTAINER 2>/dev/null; then
    echo_error "API container is not running. Run './fapi.sh up api' first."
    exit 1
  fi
  $RUNTIME exec $API_CONTAINER "$@"
}

podman_clean() {
  local service="${1:-all}"
  if [ "$service" = "all" ]; then
    pod_destroy
    $RUNTIME volume rm $PGDATA_VOLUME 2>/dev/null || true
    echo_success "All containers and volumes removed."
  else
    $RUNTIME rm -f "${CONTAINER_PREFIX}$service" 2>/dev/null || true
    echo_success "$service container removed."
  fi
}

podman_fresh() {
  pod_destroy
  $RUNTIME volume rm $PGDATA_VOLUME 2>/dev/null || true
  $RUNTIME rmi -f fluent-api 2>/dev/null || true
  echo_success "Removed all containers, volumes, and images."
}

podman_build() {
  local service="${1:-api}"
  if [ "$service" = "api" ] || [ "$service" = "all" ]; then
    echo_running "Building API image..."
    $RUNTIME build -t fluent-api "$SCRIPT_DIR" -f Dockerfile.dev
    echo_success "API image built."
  else
    echo_error "Unknown buildable service: $service (only 'api' has a custom image)"
    exit 1
  fi
}

podman_db_psql() {
  $RUNTIME exec -it $DB_CONTAINER psql -U postgres -d fluent
}

# ── Docker Compose command functions ──────────────────────────────────────────

compose_up() {
  local service="${1:-}"
  if [ -z "$service" ] || [ "$service" = "all" ]; then
    $COMPOSE_CMD up -d --build
  else
    $COMPOSE_CMD up -d --build --no-deps "$service"
  fi
}

compose_down() {
  local service="${1:-}"
  if [ -z "$service" ] || [ "$service" = "all" ]; then
    $COMPOSE_CMD down
  else
    $COMPOSE_CMD rm -sf "$service"
  fi
}

compose_restart() {
  local service="${1:-}"
  if [ -z "$service" ] || [ "$service" = "all" ]; then
    $COMPOSE_CMD restart
  else
    $COMPOSE_CMD restart "$service"
  fi
}

compose_logs() {
  $COMPOSE_CMD logs -f "$@"
}

compose_status() {
  $COMPOSE_CMD ps
}

compose_shell() {
  local service="${1:-api}"
  if [ "$service" = "db" ]; then
    $COMPOSE_CMD exec db psql -U postgres -d fluent
  else
    $COMPOSE_CMD exec "$service" sh
  fi
}

compose_exec_api() {
  $COMPOSE_CMD exec api "$@"
}

compose_clean() {
  local service="${1:-all}"
  if [ "$service" = "all" ]; then
    $COMPOSE_CMD down -v
    echo_success "All containers and volumes removed."
  else
    $COMPOSE_CMD rm -sf "$service"
    echo_success "$service container removed."
  fi
}

compose_fresh() {
  $COMPOSE_CMD down -v --rmi local --remove-orphans
  echo_success "Removed all containers, volumes, and images."
}

compose_build() {
  local service="${1:-}"
  if [ -z "$service" ] || [ "$service" = "all" ]; then
    $COMPOSE_CMD build --no-cache
  else
    $COMPOSE_CMD build --no-cache "$service"
  fi
}

compose_db_psql() {
  $COMPOSE_CMD exec db psql -U postgres -d fluent
}

# ── Runtime dispatch helpers ───────────────────────────────────────────────────

exec_api() {
  if [ "$RUNTIME_MODE" = "podman-pod" ]; then
    podman_exec_api "$@"
  else
    compose_exec_api "$@"
  fi
}

# ── Runtime mode display ──────────────────────────────────────────────────────

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  detect_runtime
  echo "Runtime mode: $RUNTIME_MODE"
  if [ "$RUNTIME_MODE" = "podman-pod" ]; then
    echo "Using native Podman pods"
  else
    echo "Using Docker Compose (${COMPOSE_CMD})"
  fi
  echo ""

  cmd="${1:-help}"
  shift || true

  case "$cmd" in
  up)
    if [ "$RUNTIME_MODE" = "podman-pod" ]; then
      podman_up "${1:-all}"
    else
      compose_up "${1:-}"
    fi
    ;;

  down)
    if [ "$RUNTIME_MODE" = "podman-pod" ]; then
      podman_down "${1:-all}"
    else
      compose_down "${1:-}"
    fi
    ;;

  restart)
    if [ "$RUNTIME_MODE" = "podman-pod" ]; then
      podman_restart "${1:-all}"
    else
      compose_restart "${1:-}"
    fi
    ;;

  logs)
    if [ "$RUNTIME_MODE" = "podman-pod" ]; then
      podman_logs "${1:-}"
    else
      compose_logs "$@"
    fi
    ;;

  status)
    if [ "$RUNTIME_MODE" = "podman-pod" ]; then
      podman_status
    else
      compose_status
    fi
    ;;

  shell)
    if [ "$RUNTIME_MODE" = "podman-pod" ]; then
      podman_shell "${1:-api}"
    else
      compose_shell "${1:-api}"
    fi
    ;;

  # ── Development commands ───────────────────────────────────────────────────

  test)
    exec_api npm run test "$@"
    ;;

  lint)
    exec_api npm run lint "$@"
    ;;

  lint:fix)
    exec_api npm run lint:fix "$@"
    ;;

  format)
    exec_api npm run format "$@"
    ;;

  format:check)
    exec_api npm run format:check "$@"
    ;;

  typecheck)
    exec_api npm run typecheck "$@"
    ;;

  run)
    exec_api npm run "$@"
    ;;

  # ── Database commands ──────────────────────────────────────────────────────

  db:migrate)
    echo_running "Running fluent-api migrations..."
    exec_api npx drizzle-kit migrate
    ;;

  db:seed)
    echo_running "Seeding organizations..."
    exec_api npm run db:seed:org
    echo_running "Seeding roles..."
    exec_api npm run db:seed:roles
    echo_running "Seeding RBAC data..."
    exec_api npm run db:seed:rbac
    echo_running "Seeding dev users..."
    exec_api npm run db:seed:dev-users
    echo_success "All seeds complete."
    ;;

  db:init)
    echo_running "Full database initialization (migrations + seeds)..."
    read -rp "This will run all migrations and seeds. Continue? [y/N] " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      exec_api npm run db:setup
      echo_success "Database initialization complete."
    else
      echo "Aborted."
    fi
    ;;

  db:generate)
    name="${1:?Usage: fapi.sh db:generate <name>}"
    exec_api npx drizzle-kit generate --name "$name"
    ;;

  db:studio)
    echo_running "Running Drizzle Studio on host (requires local Node.js)..."
    echo "  Connects to DB via DATABASE_URL in .env (localhost:${DB_PORT})"
    npx drizzle-kit studio
    ;;

  db:psql)
    if [ "$RUNTIME_MODE" = "podman-pod" ]; then
      podman_db_psql
    else
      compose_db_psql
    fi
    ;;

  db:dump-schema)
    output="${1:-}"
    if [ -z "$output" ]; then
      if [ -d "$SCRIPT_DIR/../fluent-ai/db/init" ]; then
        output="$SCRIPT_DIR/../fluent-ai/db/init/02-fluent-api-schema.sql"
      else
        output="$SCRIPT_DIR/fluent-api-schema-dump.sql"
      fi
    fi
    echo_running "Dumping fluent-api public schema to $output..."
    {
      cat <<'HEADER'
-- Schema-only dump of fluent-api's public tables.
-- Used for standalone fluent-ai development so cross-schema reads work.
--
-- This file is auto-generated. DO NOT EDIT MANUALLY.
-- Regenerate with: ./fapi.sh db:dump-schema [output-path]
-- Then commit to fluent-ai/db/init/ to update the standalone DB snapshot.
HEADER
      if [ "$RUNTIME_MODE" = "podman-pod" ]; then
        $RUNTIME exec $DB_CONTAINER pg_dump -U postgres --schema-only --schema=public fluent
      else
        $COMPOSE_CMD exec -T db pg_dump -U postgres --schema-only --schema=public fluent
      fi
    } > "$output"
    echo_success "Schema dumped to $output"
    echo "Next: commit this file to fluent-ai/db/init/ and run './fai.sh clean && ./fai.sh up' to sync."
    ;;

  # ── Lifecycle commands ─────────────────────────────────────────────────────

  clean)
    echo_running "This will stop and remove containers$([ "${1:-all}" = "all" ] && echo " and volumes" || true)."
    read -rp "Continue? [y/N] " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      if [ "$RUNTIME_MODE" = "podman-pod" ]; then
        podman_clean "${1:-all}"
      else
        compose_clean "${1:-all}"
      fi
    else
      echo "Aborted."
    fi
    ;;

  fresh)
    echo_running "This will destroy ALL containers, volumes, and images."
    read -rp "Continue? [y/N] " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      if [ "$RUNTIME_MODE" = "podman-pod" ]; then
        podman_fresh
      else
        compose_fresh
      fi
      echo ""
      echo_success "Clean slate. Run './fapi.sh up' to rebuild and start everything."
    else
      echo "Aborted."
    fi
    ;;

  build)
    if [ "$RUNTIME_MODE" = "podman-pod" ]; then
      podman_build "${1:-api}"
    else
      compose_build "${1:-}"
    fi
    ;;

  setup)
    if [[ ! -f .env ]]; then
      if [[ -f .env.example ]]; then
        cp .env.example .env
        echo "Created .env from .env.example"
      else
        touch .env
        echo "Created empty .env file"
      fi
    else
      echo ".env already exists, skipping."
    fi
    echo "Remember to fill in DATABASE_URL and BETTER_AUTH_SECRET in .env before running db:init."
    ;;

  help|*)
    cat <<'USAGE'
Usage: ./fapi.sh <command> [service] [args]

Operating modes:
  Standalone  ./fapi.sh up          — own DB on 5432 + API + worker (safe alongside platform)
  Service     ./fapi.sh up api      — API only; point DATABASE_URL at an existing DB
  Ecosystem   ./fluent.sh up        — platform orchestrator owns the shared DB on 5432

Services: db | api | worker | (omit for all)

Container management:
  up [service]           Start services (default: all — DB on 5432, then API, then worker)
  down [service]         Stop and remove services (default: all)
  restart [service]      Restart services (default: all)
  logs [service]         Tail logs (default: all)
  status                 Show container/pod status
  shell [service]        Open a shell (default: api; db opens psql)

Development (runs in API container):
  test                   Run test suite
  lint                   Run ESLint
  lint:fix               Run ESLint with auto-fix
  format                 Format code with Prettier
  format:check           Check formatting with Prettier
  typecheck              Run TypeScript type checking
  run <script>           Run an npm script inside the API container

Database:
  db:migrate             Run Drizzle migrations
  db:seed                Seed all data (org, roles, RBAC, dev users)
  db:init                Run migrations + all seeds (delegates to npm run db:setup)
  db:generate <name>     Generate a new Drizzle migration
  db:studio              Launch Drizzle Studio on the host
  db:psql                Open psql session
  db:dump-schema [path]  pg_dump public schema for fluent-ai standalone sync

Lifecycle:
  clean [service]        Remove containers and volumes (default: all)
  fresh                  Nuke everything: containers, volumes, and images
  build [service]        Rebuild images without cache
  setup                  Create .env from .env.example if missing

Environment variables:
  DB_PORT                Standalone DB host port (default: 5432)
  API_PORT               API service host port (default: 9999)
  DATABASE_URL           Override DB connection (set in .env to use platform DB)
USAGE
    ;;
  esac
fi
