#Requires -Version 5.1
param(
    [Parameter(Position = 0)]
    [string]$Command = "help",
    [Parameter(Position = 1)]
    [string]$Service = "",
    [Parameter(Position = 2, ValueFromRemainingArguments)]
    [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# ── Runtime detection (prefer native Podman pods) ─────────────────────────────

$RuntimeMode = ""
$Runtime     = ""
$ComposeCmd  = ""

if (Get-Command podman -ErrorAction SilentlyContinue) {
    $RuntimeMode = "podman-pod"
    $Runtime     = "podman"
} elseif (Get-Command docker -ErrorAction SilentlyContinue) {
    $v2check = & docker compose version 2>&1
    if ($LASTEXITCODE -eq 0) {
        $RuntimeMode = "docker-compose"
        $ComposeCmd  = "docker compose"
    } elseif (Get-Command docker-compose -ErrorAction SilentlyContinue) {
        $RuntimeMode = "docker-compose"
        $ComposeCmd  = "docker-compose"
    }
}

if (-not $RuntimeMode) {
    Write-Error @"
No container runtime found. Install one of:
  - Podman (native pods)
  - Docker Desktop (includes docker compose V2)
  - Docker Engine + docker-compose
"@
    exit 1
}

# ── Color helpers ─────────────────────────────────────────────────────────────

function Write-Running { param($Msg) Write-Host ">>> $Msg" -ForegroundColor Yellow }
function Write-Success { param($Msg) Write-Host ">>> $Msg" -ForegroundColor Green  }
function Write-Err     { param($Msg) Write-Host ">>> $Msg" -ForegroundColor Red    }

# ── Podman pod configuration ──────────────────────────────────────────────────

$PodName = "fluent-api"
$DbPort  = if ($env:DB_PORT)  { $env:DB_PORT  } else { "5432" }
$ApiPort = if ($env:API_PORT) { $env:API_PORT } else { "9999" }

# ── Podman helpers ────────────────────────────────────────────────────────────

function Test-PodExists {
    & podman pod exists $PodName 2>&1 | Out-Null
    return $LASTEXITCODE -eq 0
}

function Test-ContainerExists {
    param([string]$Name)
    & podman container exists $Name 2>&1 | Out-Null
    return $LASTEXITCODE -eq 0
}

function New-Pod {
    if (Test-PodExists) { Write-Success "Pod $PodName already exists"; return }
    Write-Running "Creating pod $PodName..."
    & podman pod create --name $PodName --share "net,ipc,uts" `
        -p "${DbPort}:5432" -p "${ApiPort}:9999"
}

function Remove-Pod {
    if (Test-PodExists) {
        Write-Running "Removing pod $PodName..."
        & podman pod rm $PodName -f
    }
}

function New-Volumes {
    Write-Running "Creating volumes..."
    & podman volume create fluent-api-pgdata 2>&1 | Out-Null
}

function Wait-ForDb {
    Write-Running "Waiting for database to be ready..."
    $retries = 30
    do {
        Start-Sleep 2
        $retries--
        if ($retries -le 0) { Write-Err "Database did not become ready in time"; exit 1 }
    } while (-not (& podman exec fluent-api-db pg_isready -U postgres -d fluent 2>&1 | Select-String "accepting connections"))
    Write-Success "Database is ready"
}

function Wait-ForApi {
    Write-Running "Waiting for API to be ready..."
    $retries = 30
    while ($retries -gt 0) {
        & podman exec fluent-api-api curl -sf http://localhost:9999/health 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Success "API is ready"; return }
        $retries--
        Start-Sleep 3
    }
    Write-Err "API did not become healthy in time"
    exit 1
}

function Start-DbContainer {
    if (Test-ContainerExists "fluent-api-db") { Write-Success "Database container already exists"; return }
    Write-Running "Starting database container..."
    & podman run -d `
        --name fluent-api-db --pod $PodName `
        -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fluent `
        -v fluent-api-pgdata:/var/lib/postgresql/data `
        -v "${ScriptDir}/db/init:/docker-entrypoint-initdb.d:ro" `
        --health-cmd "pg_isready -U postgres -d fluent" `
        --health-interval 5s --health-timeout 5s --health-retries 5 `
        docker.io/postgres:16-alpine
    if ($LASTEXITCODE -ne 0) { Write-Err "Failed to start database container"; exit 1 }
    Write-Success "Database container started"
}

function Get-EnvFlags {
    $flags = @(
        "-e", "NODE_ENV=development",
        "-e", "DATABASE_URL=postgres://postgres:postgres@localhost:5432/fluent",
        "-e", "EXPORTS_DIR=/app/exports"
    )
    if (Test-Path "$ScriptDir/.env") { $flags += @("--env-file", "$ScriptDir/.env") }
    return $flags
}

function Start-ApiContainer {
    if (Test-ContainerExists "fluent-api-api") { Write-Success "API container already exists"; return }
    Write-Running "Building API image..."
    & podman build -t fluent-api $ScriptDir -f Dockerfile.dev
    if ($LASTEXITCODE -ne 0) { Write-Err "Failed to build API image"; exit 1 }
    Write-Running "Starting API container..."
    & podman run -d `
        --name fluent-api-api --pod $PodName `
        @(Get-EnvFlags) `
        -v "${ScriptDir}/src:/app/src:ro" `
        -v "${ScriptDir}/tsconfig.json:/app/tsconfig.json:ro" `
        -v "${ScriptDir}/drizzle.config.ts:/app/drizzle.config.ts:ro" `
        -v "${ScriptDir}/docker-entrypoint.sh:/app/docker-entrypoint.sh:ro" `
        --tmpfs /tmp:noexec,nosuid,size=64m `
        --tmpfs /app/.cache:noexec,nosuid,size=128m `
        --tmpfs /app/exports:noexec,nosuid,size=256m `
        --security-opt no-new-privileges:true --cap-drop ALL `
        --user 1001:1001 --read-only `
        fluent-api
    if ($LASTEXITCODE -ne 0) { Write-Err "Failed to start API container"; exit 1 }
    Write-Success "API container started"
}

function Start-WorkerContainer {
    if (Test-ContainerExists "fluent-api-worker") { Write-Success "Worker container already exists"; return }
    Write-Running "Starting worker container..."
    & podman run -d `
        --name fluent-api-worker --pod $PodName `
        @(Get-EnvFlags) `
        -v "${ScriptDir}/src:/app/src:ro" `
        -v "${ScriptDir}/tsconfig.json:/app/tsconfig.json:ro" `
        --tmpfs /tmp:noexec,nosuid,size=64m `
        --tmpfs /app/.cache:noexec,nosuid,size=128m `
        --tmpfs /app/exports:noexec,nosuid,size=256m `
        --security-opt no-new-privileges:true --cap-drop ALL `
        --user 1001:1001 --read-only `
        fluent-api `
        npx tsx watch src/workers/standalone-worker.ts
    if ($LASTEXITCODE -ne 0) { Write-Err "Failed to start worker container"; exit 1 }
    Write-Success "Worker container started"
}

function Start-AllServices {
    New-Volumes
    New-Pod
    Start-DbContainer
    Wait-ForDb
    Start-ApiContainer
    Wait-ForApi
    Start-WorkerContainer
    Write-Success "All services started!"
}

# ── Compose helpers ───────────────────────────────────────────────────────────

function Invoke-Compose {
    param([string[]]$CmdArgs)
    if ($ComposeCmd -eq "docker compose") { & docker compose @CmdArgs }
    else { & docker-compose @CmdArgs }
}

function Invoke-ExecApi {
    param([string[]]$CmdArgs)
    if ($RuntimeMode -eq "podman-pod") { & podman exec fluent-api-api @CmdArgs }
    else { Invoke-Compose (@("exec", "api") + $CmdArgs) }
}

# ── Runtime mode display ──────────────────────────────────────────────────────

Write-Host "Runtime mode: $RuntimeMode"
if ($RuntimeMode -eq "podman-pod") { Write-Host "Using native Podman pods" }
else { Write-Host "Using Docker Compose ($ComposeCmd)" }
Write-Host ""

# ── Commands ──────────────────────────────────────────────────────────────────

$svc = $Service

switch ($Command) {

  "up" {
    $target = if ($svc) { $svc } else { "all" }
    if ($RuntimeMode -eq "podman-pod") {
      switch ($target) {
        "all"    { Start-AllServices }
        "db"     { New-Volumes; New-Pod; Start-DbContainer; Write-Success "Database started!" }
        "api"    { New-Pod; Start-ApiContainer; Write-Success "API service started!" }
        "worker" { New-Pod; Start-WorkerContainer; Write-Success "Worker started!" }
        default  { Write-Err "Unknown service: $target (use: db, api, worker, or omit for all)"; exit 1 }
      }
    } else {
      if ($target -eq "all" -or -not $target) { Invoke-Compose @("up", "-d", "--build") }
      else { Invoke-Compose @("up", "-d", "--build", "--no-deps", $target) }
    }
  }

  "down" {
    $target = if ($svc) { $svc } else { "all" }
    if ($RuntimeMode -eq "podman-pod") {
      if ($target -eq "all") { Remove-Pod; Write-Success "All services stopped." }
      else { & podman rm -f "fluent-api-$target" 2>&1 | Out-Null; Write-Success "$target stopped." }
    } else {
      if ($target -eq "all") { Invoke-Compose @("down") }
      else { Invoke-Compose @("rm", "-sf", $target) }
    }
  }

  "restart" {
    $target = if ($svc) { $svc } else { "all" }
    if ($RuntimeMode -eq "podman-pod") {
      if ($target -eq "all") { Remove-Pod; Start-AllServices }
      else {
        & podman rm -f "fluent-api-$target" 2>&1 | Out-Null
        switch ($target) {
          "db"     { Start-DbContainer }
          "api"    { Start-ApiContainer }
          "worker" { Start-WorkerContainer }
          default  { Write-Err "Unknown service: $target"; exit 1 }
        }
        Write-Success "Restarted $target"
      }
    } else {
      if ($target -eq "all") { Invoke-Compose @("restart") }
      else { Invoke-Compose @("restart", $target) }
    }
  }

  "logs" {
    if ($RuntimeMode -eq "podman-pod") {
      if ($svc) { & podman logs -f "fluent-api-$svc" }
      else { & podman pod logs -f $PodName }
    } else {
      if ($svc) { Invoke-Compose @("logs", "-f", $svc) }
      else { Invoke-Compose @("logs", "-f") }
    }
  }

  "status" {
    if ($RuntimeMode -eq "podman-pod") {
      & podman pod ps
      if (Test-PodExists) {
        Write-Host ""
        Write-Host "Containers in pod $PodName (all states):"
        & podman ps -a --filter "pod=$PodName"
      }
    } else { Invoke-Compose @("ps") }
  }

  "shell" {
    $target = if ($svc) { $svc } else { "api" }
    if ($RuntimeMode -eq "podman-pod") {
      if ($target -eq "db") { & podman exec -it fluent-api-db psql -U postgres -d fluent }
      else { & podman exec -it "fluent-api-$target" sh }
    } else {
      if ($target -eq "db") { Invoke-Compose @("exec", "db", "psql", "-U", "postgres", "-d", "fluent") }
      else { Invoke-Compose @("exec", $target, "sh") }
    }
  }

  "test"         { Invoke-ExecApi (@("npm", "run", "test") + $ExtraArgs) }
  "lint"         { Invoke-ExecApi (@("npm", "run", "lint") + $ExtraArgs) }
  "lint:fix"     { Invoke-ExecApi (@("npm", "run", "lint:fix") + $ExtraArgs) }
  "format"       { Invoke-ExecApi (@("npm", "run", "format") + $ExtraArgs) }
  "format:check" { Invoke-ExecApi (@("npm", "run", "format:check") + $ExtraArgs) }
  "typecheck"    { Invoke-ExecApi (@("npm", "run", "typecheck") + $ExtraArgs) }
  "run"          { Invoke-ExecApi (@("npm", "run") + $ExtraArgs) }

  "db:migrate" { Write-Running "Running fluent-api migrations..."; Invoke-ExecApi @("npx", "drizzle-kit", "migrate") }
  "db:seed" {
    Write-Running "Seeding organizations..."
    Invoke-ExecApi @("npm", "run", "db:seed:org")
    Write-Running "Seeding roles..."
    Invoke-ExecApi @("npm", "run", "db:seed:roles")
    Write-Running "Seeding RBAC data..."
    Invoke-ExecApi @("npm", "run", "db:seed:rbac")
    Write-Running "Seeding dev users..."
    Invoke-ExecApi @("npm", "run", "db:seed:dev-users")
    Write-Success "All seeds complete."
  }

  "db:init" {
    Write-Running "Full database initialization (migrations + seeds)..."
    $confirm = Read-Host "This will run all migrations and seeds. Continue? [y/N]"
    if ($confirm -match "^[Yy]$") {
      Invoke-ExecApi @("npm", "run", "db:setup")
      Write-Success "Database initialization complete."
    } else { Write-Host "Aborted." }
  }

  "db:generate" {
    if (-not $svc) { Write-Error "Usage: fapi.ps1 db:generate <name>"; exit 1 }
    Invoke-ExecApi @("npx", "drizzle-kit", "generate", "--name", $svc)
  }

  "db:studio" {
    Write-Running "Running Drizzle Studio on host (requires local Node.js)..."
    Write-Host "  Connects to DB via DATABASE_URL in .env (localhost:${DbPort})"
    & npx drizzle-kit studio
  }

  "db:psql" {
    if ($RuntimeMode -eq "podman-pod") { & podman exec -it fluent-api-db psql -U postgres -d fluent }
    else { Invoke-Compose @("exec", "db", "psql", "-U", "postgres", "-d", "fluent") }
  }

  "db:dump-schema" {
    $output = $svc
    if (-not $output) {
      $aiInitDir = Join-Path $ScriptDir "../fluent-ai/db/init"
      if (Test-Path $aiInitDir) { $output = Join-Path $aiInitDir "02-fluent-api-schema.sql" }
      else { $output = Join-Path $ScriptDir "fluent-api-schema-dump.sql" }
    }
    Write-Running "Dumping fluent-api public schema to $output..."
    $header = @"
-- Schema-only dump of fluent-api's public tables.
-- Used for standalone fluent-ai development so cross-schema reads work.
--
-- This file is auto-generated. DO NOT EDIT MANUALLY.
-- Regenerate with: ./fapi.ps1 db:dump-schema [output-path]
-- Then commit to fluent-ai/db/init/ to update the standalone DB snapshot.
"@
    if ($RuntimeMode -eq "podman-pod") {
      $dump = & podman exec fluent-api-db pg_dump -U postgres --schema-only --schema=public fluent
      if ($LASTEXITCODE -ne 0) { Write-Err "pg_dump failed"; exit 1 }
    } else {
      $dump = Invoke-Compose @("exec", "-T", "db", "pg_dump", "-U", "postgres", "--schema-only", "--schema=public", "fluent")
      if ($LASTEXITCODE -ne 0) { Write-Err "pg_dump failed"; exit 1 }
    }
    "$header`n$dump" | Set-Content $output -Encoding UTF8
    Write-Success "Schema dumped to $output"
    Write-Host "Next: commit this file to fluent-ai/db/init/ and run './fai.sh clean && ./fai.sh up' to sync."
  }

  "clean" {
    Write-Running "This will stop and remove containers and volumes."
    $confirm = Read-Host "Continue? [y/N]"
    if ($confirm -match "^[Yy]$") {
      $target = if ($svc) { $svc } else { "all" }
      if ($RuntimeMode -eq "podman-pod") {
        if ($target -eq "all") {
          Remove-Pod
          & podman volume rm fluent-api-pgdata 2>&1 | Out-Null
          Write-Success "All containers and volumes removed."
        } else {
          & podman rm -f "fluent-api-$target" 2>&1 | Out-Null
          Write-Success "$target container removed."
        }
      } else {
        Invoke-Compose @("down", "-v")
        Write-Success "All containers and volumes removed."
      }
    } else { Write-Host "Aborted." }
  }

  "fresh" {
    Write-Running "This will destroy ALL containers, volumes, and images."
    $confirm = Read-Host "Continue? [y/N]"
    if ($confirm -match "^[Yy]$") {
      if ($RuntimeMode -eq "podman-pod") {
        Remove-Pod
        & podman volume rm fluent-api-pgdata 2>&1 | Out-Null
        & podman rmi -f fluent-api 2>&1 | Out-Null
      } else {
        Invoke-Compose @("down", "-v", "--rmi", "local", "--remove-orphans")
      }
      Write-Success "Removed all containers, volumes, and images."
      Write-Host ""
      Write-Success "Clean slate. Run './fapi.ps1 up' to rebuild and start everything."
    } else { Write-Host "Aborted." }
  }

  "build" {
    $target = if ($svc) { $svc } else { if ($RuntimeMode -eq "podman-pod") { "api" } else { "all" } }
    if ($RuntimeMode -eq "podman-pod") {
      if ($target -eq "api" -or $target -eq "all") {
        Write-Running "Building API image..."
        & podman build -t fluent-api $ScriptDir -f Dockerfile.dev
        Write-Success "API image built."
      } else { Write-Err "Unknown buildable service: $target"; exit 1 }
    } else {
      if ($target -eq "all") { Invoke-Compose @("build", "--no-cache") }
      else { Invoke-Compose @("build", "--no-cache", $target) }
    }
  }

  "setup" {
    if (-not (Test-Path "$ScriptDir/.env")) {
      if (Test-Path "$ScriptDir/.env.example") {
        Copy-Item "$ScriptDir/.env.example" "$ScriptDir/.env"
        Write-Host "Created .env from .env.example"
      } else {
        New-Item "$ScriptDir/.env" -ItemType File | Out-Null
        Write-Host "Created empty .env file"
      }
    } else { Write-Host ".env already exists, skipping." }
    Write-Host "Remember to fill in DATABASE_URL and BETTER_AUTH_SECRET in .env before running db:init."
  }

  default {
    Write-Host @"
Usage: .\fapi.ps1 <command> [service] [args]

Operating modes:
  Standalone  .\fapi.ps1 up          -- own DB on 5432 + API + worker
  Service     .\fapi.ps1 up api      -- API only; point DATABASE_URL at an existing DB
  Ecosystem   .\fluent.ps1 up        -- platform orchestrator owns the shared DB

Services: db | api | worker | (omit for all)

Container management:
  up [service]           Start services (default: all)
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
  db:dump-schema [path]  Dump public schema for fluent-ai standalone sync

Lifecycle:
  clean [service]        Remove containers and volumes (default: all)
  fresh                  Nuke everything: containers, volumes, and images
  build [service]        Rebuild images without cache
  setup                  Create .env from .env.example if missing
"@
  }
}
