param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $FunctionAppName
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("arquifusion-azure-intelligence-" + [guid]::NewGuid().ToString("N"))
$sharedPackage = Join-Path $repoRoot "cloud\gcp\intelligence\src\arquifusion_intelligence"
$eventSchema = Join-Path $repoRoot "packages\contracts\events.schema.json"

if (-not (Get-Command func -ErrorAction SilentlyContinue)) { throw "Azure Functions Core Tools v4 (func) is required." }
if (-not (Test-Path $sharedPackage)) { throw "Shared Python intelligence package is missing." }
if (-not (Test-Path $eventSchema)) { throw "Shared v1 event schema is missing." }

try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  Copy-Item (Join-Path $PSScriptRoot "function_app.py") $stageRoot
  Copy-Item (Join-Path $PSScriptRoot "host.json") $stageRoot
  Copy-Item (Join-Path $PSScriptRoot "requirements.txt") $stageRoot
  Copy-Item (Join-Path $PSScriptRoot ".funcignore") $stageRoot

  # Keep the Python module's original repository-relative layout so its existing
  # events.schema.json resolver and all service logic remain unchanged.
  $sharedRoot = Join-Path $stageRoot "cloud\gcp\intelligence\src"
  New-Item -ItemType Directory -Path $sharedRoot -Force | Out-Null
  Copy-Item $sharedPackage (Join-Path $sharedRoot "arquifusion_intelligence") -Recurse
  $schemaRoot = Join-Path $stageRoot "packages\contracts"
  New-Item -ItemType Directory -Path $schemaRoot -Force | Out-Null
  Copy-Item $eventSchema (Join-Path $schemaRoot "events.schema.json")

  Push-Location $stageRoot
  try {
    & func azure functionapp publish $FunctionAppName --build remote
    if ($LASTEXITCODE -ne 0) { throw "Azure Functions publish failed with exit code $LASTEXITCODE." }
  }
  finally { Pop-Location }
}
finally {
  if (Test-Path $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
}
