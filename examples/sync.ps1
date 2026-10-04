param([string]$DataDir = ".wolai-notion-sync")
$ErrorActionPreference = "Stop"
if (-not $env:WOLAI_MCP_TOKEN -or -not $env:NOTION_TOKEN) { throw "Configure credentials in a private environment first." }
Push-Location (Join-Path $PSScriptRoot "..")
try { & node "bin/cli.mjs" sync --apply --data-dir $DataDir; exit $LASTEXITCODE } finally { Pop-Location }
