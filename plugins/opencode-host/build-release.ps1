<#
.SYNOPSIS
  Builds the package that makes this plugin installable from the plugin market.

.DESCRIPTION
  The gateway's github-release installer resolves `releases/tags/v{version}` in
  this repository, looks for an asset named by the registry entry's
  `artifact_pattern`, and verifies it against checksums.txt — see meta-gateway's
  internal/plugins/market_install.go.

  This plugin contains no platform-specific code: it is JavaScript, and the
  gateway image provides the runtime (the manifest's entrypoint is the bare name
  "node", so the host supplies it instead of the package carrying one 84 MB
  executable per architecture). The package is therefore ONE zip for every
  platform, which is also why the registry entry sets
  `artifact_pattern: "{id}_{version}.zip"`.

  dist/ is build output and stays out of git (.gitignore): the released package
  is the GitHub Release asset, not a committed file.

.EXAMPLE
  ./build-release.ps1 -Version 0.3.0
  # upload dist/* to the GitHub release tagged v0.3.0
#>
[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = "Stop"
$id = "opencode-host"
$root = $PSScriptRoot
$dist = Join-Path $root "dist"
$stage = Join-Path $dist "_stage"

Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dist, $stage, (Join-Path $stage "src"), (Join-Path $stage "public") | Out-Null

# The manifest is read from the file the plugin ships, never rebuilt here: one
# definition, and the packaged copy cannot drift from the served one. Only the
# version is stamped, so the registry entry and the package always agree.
$manifest = Get-Content (Join-Path $root "plugin.json") -Raw | ConvertFrom-Json
$manifest.version = $Version
$manifest | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $stage "plugin.json") -Encoding utf8NoBOM

Copy-Item (Join-Path $root "package.json") (Join-Path $stage "package.json") -Force
Copy-Item (Join-Path $root "src\host.mjs") (Join-Path $stage "src\host.mjs") -Force
Copy-Item (Join-Path $root "public\index.html") (Join-Path $stage "public\index.html") -Force

$zipName = "${id}_${Version}.zip"
$zipPath = Join-Path $dist $zipName
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -Force
Remove-Item -Recurse -Force $stage

# sha256sum format: the gateway reads "<hex>  <file>" per line.
$hash = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLower()
Set-Content -Path (Join-Path $dist "checksums.txt") -Value "$hash  $zipName" -Encoding utf8NoBOM

Write-Host "`npackaged $id $Version into $dist"
Get-ChildItem $dist | ForEach-Object { Write-Host ("  {0}  {1} bytes" -f $_.Name, $_.Length) }
Write-Host "`nupload them to the release tagged v${Version}:"
Write-Host "  git tag -a v$Version -m `"$id $Version`" && git push origin v$Version"
