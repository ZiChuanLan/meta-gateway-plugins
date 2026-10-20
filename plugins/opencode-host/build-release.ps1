<#
.SYNOPSIS
  Builds the artifacts that make this plugin installable from the plugin market.

.DESCRIPTION
  The gateway's github-release installer looks for an asset named
  "{id}_{version}_{goos}_{goarch}.zip" plus a "checksums.txt", and downloads the
  one matching its OWN goos/goarch — see meta-gateway's
  internal/plugins/market_install.go. The platforms that matter are therefore the
  ones the gateway runs on, so linux/amd64 and linux/arm64 cover both container
  architectures, and windows/darwin cover the desktop installs.

  Each package is ONE file to the operator: Bun compiles src/host.mjs together
  with its runtime, so the installed plugin needs neither Node nor npm on the
  gateway host. Installing a provider package at run time still needs `tar`
  (busybox's is enough) and CA certificates to reach the npm registry — that is
  the whole dependency list. Linux targets use the musl build: it runs on Alpine
  (the gateway's own image) as long as libstdc++ is present, and on glibc
  distributions too.

  Every zip carries the plugin.json the gateway reads next to the binary it
  declares as the entrypoint, plus the admin page the host serves. dist/ is build
  output and stays out of git (.gitignore): the released package is the GitHub
  Release asset, not a committed file — the installer resolves it as
  `releases/tags/v{version}`, so this repository's one tag per version must hold
  every plugin it packages (see the README).

.EXAMPLE
  ./build-release.ps1 -Version 0.2.3
  # upload dist/* to the GitHub release tagged v0.2.3
#>
[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$Version,
	[string[]]$Targets = @("linux/amd64", "linux/arm64", "windows/amd64", "darwin/arm64"),
	[ValidateSet("auto", "bun", "docker")][string]$Builder = "auto"
)

$ErrorActionPreference = "Stop"
$id = "opencode-host"
$root = $PSScriptRoot
$dist = Join-Path $root "dist"
$stage = Join-Path $dist "_stage"

Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dist, $stage | Out-Null

# The manifest is read from the file the plugin ships, never rebuilt here: one
# definition, and the packaged copy cannot drift from the served one.
$manifest = Get-Content (Join-Path $root "plugin.json") -Raw | ConvertFrom-Json

# Which Bun does the cross-compiling. A Bun installed on Windows cannot fetch the
# Linux/macOS runtimes it compiles against ("Failed to extract executable"), so a
# Windows checkout builds inside the container image instead — that is the case
# here. On Linux CI (and on a Linux box) the local Bun is used directly, which is
# faster and needs no daemon.
# $output is relative to the plugin directory: the container sees the same paths
# under /src, so one string works for both builders.
function Invoke-BunBuild([string]$target, [string]$output) {
	$output = $output.Replace("\", "/")
	if ($Builder -eq "bun" -or $Builder -eq "auto" -and -not $IsWindows) {
		& bun build --compile --minify "--target=$target" src/host.mjs "--outfile=$output"
		if ($LASTEXITCODE -ne 0) { throw "bun build failed for $target" }
		return
	}
	docker run --rm -v "${root}:/src" -w /src oven/bun:1 `
		sh -c "bun build --compile --minify --target=$target src/host.mjs --outfile=$output"
	if ($LASTEXITCODE -ne 0) { throw "docker build failed for $target" }
}

$checksumLines = @()
foreach ($target in $Targets) {
	$goos, $goarch = $target.Split("/")
	$bunTarget = switch ($target) {
		"linux/amd64" { "bun-linux-x64-musl" }
		"linux/arm64" { "bun-linux-arm64-musl" }
		"windows/amd64" { "bun-windows-x64" }
		"windows/arm64" { "bun-windows-arm64" }
		"darwin/amd64" { "bun-darwin-x64" }
		"darwin/arm64" { "bun-darwin-arm64" }
		default { throw "no Bun target for $target" }
	}
	$binaryName = if ($goos -eq "windows") { "$id.exe" } else { $id }
	Write-Host "building $target ($bunTarget)"

	Push-Location $root
	try {
		Invoke-BunBuild $bunTarget "dist/_stage/$binaryName"
	} finally {
		Pop-Location
	}

	# The admin page travels with the binary (readPage looks next to it).
	Copy-Item (Join-Path $root "public\index.html") (Join-Path $stage "index.html") -Force

	# The gateway validates the manifest's entrypoint against the files in the
	# package (plugins.validatePluginManifestForPackage), so the packaged copy has
	# to name the file this target actually ships: a bare "opencode-host" fails on
	# Windows with plugin_manifest_entrypoint_missing while installing fine on
	# Linux.
	$packaged = $manifest.PSObject.Copy()
	$packaged.version = $Version
	$packaged.entrypoint = $binaryName
	$packaged | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $stage "plugin.json") -Encoding utf8NoBOM

	$zipName = "${id}_${Version}_${goos}_${goarch}.zip"
	$zipPath = Join-Path $dist $zipName
	Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -Force
	Remove-Item (Join-Path $stage $binaryName) -Force

	$hash = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLower()
	$checksumLines += "$hash  $zipName"
}

# sha256sum format: the gateway reads "<hex>  <file>" per line.
Set-Content -Path (Join-Path $dist "checksums.txt") -Value ($checksumLines -join "`n") -Encoding utf8NoBOM
Remove-Item -Recurse -Force $stage

Write-Host "`npackaged $id $Version into $dist"
Get-ChildItem $dist | ForEach-Object { Write-Host ("  {0}  {1} bytes" -f $_.Name, $_.Length) }
Write-Host "`nupload them to the release tagged v${Version}:"
Write-Host "  git tag -a v$Version -m `"$id $Version`" && git push origin v$Version"
