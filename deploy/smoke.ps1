param([string]$Image = 'luminaos-api:arm64-check')
$ErrorActionPreference = 'Stop'
$project = 'lumina-smoke-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$root = Split-Path $PSScriptRoot -Parent
$composeArgs = @('compose', '-p', $project, '-f', "$root/docker-compose.production.yml", '-f', "$root/deploy/compose.smoke.yml")
$smokeEmail = "smoke-$([Guid]::NewGuid().ToString('N'))@example.test"
$smokePassword = [Guid]::NewGuid().ToString('N')
$smokeWorkspace = "Container smoke $([Guid]::NewGuid().ToString('N'))"
$settings = @{
    SMOKE_IMAGE = $Image
    POSTGRES_USER = 'smoke'
    POSTGRES_DB = 'smoke'
    POSTGRES_PASSWORD = [Guid]::NewGuid().ToString('N')
    ENCRYPTION_KEY = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Guid]::NewGuid().ToString('N')))
    SERVER_PUBLIC_URL = 'http://127.0.0.1:3000'
    WEB_ORIGIN = 'http://127.0.0.1:3000'
    LOG_LEVEL = 'info'
}
$original = @{}
function Invoke-SmokeCompose {
    param([string[]]$DockerArgs)
    & docker @composeArgs @DockerArgs
    if ($LASTEXITCODE -ne 0) { throw "Compose operation failed: $($DockerArgs[0])" }
}
function Invoke-ApiVerification {
    param([string]$Mode)
    Get-Content -Raw "$PSScriptRoot/verify-api.mjs" | & docker @composeArgs exec -T `
        -e "SMOKE_MODE=$Mode" `
        -e "SMOKE_EMAIL=$smokeEmail" `
        -e "SMOKE_PASSWORD=$smokePassword" `
        -e "SMOKE_WORKSPACE=$smokeWorkspace" `
        api node --input-type=module
    if ($LASTEXITCODE -ne 0) { throw "API verification failed: $Mode" }
}
try {
    foreach ($key in $settings.Keys) {
        $original[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
    }
    Invoke-SmokeCompose @('up', '-d', '--wait', 'postgres', 'redis')
    Invoke-SmokeCompose @('run', '--rm', '--no-deps', 'api', 'node', 'dist/db/migrate.js')
    Invoke-SmokeCompose @('run', '--rm', '--no-deps', 'api', 'node', 'dist/db/migrate.js')
    Invoke-SmokeCompose @('up', '-d', '--no-build', '--wait', '--wait-timeout', '360', 'api')
    Invoke-ApiVerification 'seed'

    Invoke-SmokeCompose @('stop', 'api')
    Invoke-SmokeCompose @('up', '-d', '--force-recreate', '--wait', 'postgres', 'redis')
    Invoke-SmokeCompose @('run', '--rm', '--no-deps', 'api', 'node', 'dist/db/migrate.js')
    Invoke-SmokeCompose @('up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '360', 'api')
    Invoke-ApiVerification 'verify-persistence'

    Invoke-SmokeCompose @('exec', '-T', 'postgres', 'sh', '-c', 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB" -f /backup/lumina.dump')
    Invoke-SmokeCompose @('up', '-d', '--wait', 'restore-postgres')
    Invoke-SmokeCompose @('exec', '-T', 'restore-postgres', 'sh', '-c', 'pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB" /backup/lumina.dump')
    Invoke-SmokeCompose @('exec', '-T', 'restore-postgres', 'sh', '-c', 'test "$(psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc ''select count(*) from users'')" -ge 1')
    Write-Host 'PASS: pg_dump archive restored into an empty, isolated PostgreSQL volume'
} catch {
    Write-Warning "Smoke test failed. Capturing container state and API logs before cleanup."
    & docker @composeArgs ps
    & docker @composeArgs logs --no-color --tail 200 api
    throw
} finally {
    # This UUID project was created by this invocation; delete only its test data.
    & docker @composeArgs down --volumes --remove-orphans
    foreach ($key in $original.Keys) {
        [Environment]::SetEnvironmentVariable($key, $original[$key], 'Process')
    }
}
