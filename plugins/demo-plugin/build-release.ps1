<#
.SYNOPSIS
  Builds the demo-plugin package the registry serves as a direct install.

.DESCRIPTION
  demo-plugin is listed in registry.json as install.type "direct": the gateway
  downloads the zip straight from this repository's dist/ and verifies the
  sha256 + size written next to it. So this script does two things jev-router's
  does not have to:

    1. it copies the package into the repository's dist/ directory, which is the
       only path the registry URL points at, and
    2. it prints the registry.json artifact block with the fresh sha256 + size,
       because a direct install is pinned by value, not by release tag.

  The packaged manifest is plugins/demo-plugin/plugin.json — a checked-in file,
  unlike jev-router which asks its own binary (-dump-manifest). It carries
  entrypoint + run_args, which describe how the host launches the process rather
  than what the running service serves. This script asserts the two fields that
  silently break an install when wrong: the id and the entrypoint name.

.EXAMPLE
  ./build-release.ps1 -Version 1.0.1
  # commit dist/demo-plugin_1.0.1_linux_amd64.zip and paste the printed block
  # into registry.json
#>
[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$Version,
	[string[]]$Targets = @("linux/amd64")
)

$ErrorActionPreference = "Stop"
$id = "demo-plugin"
$root = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $root "..\..")).Path
$dist = Join-Path $repoRoot "dist"
$stage = Join-Path $root ".build"
$manifestPath = Join-Path $root "plugin.json"

if (-not (Test-Path $manifestPath)) { throw "missing $manifestPath" }
$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
if ($manifest.id -ne $id) { throw "plugin.json id is '$($manifest.id)', want '$id'" }
if ($manifest.entrypoint -ne $id) { throw "plugin.json entrypoint is '$($manifest.entrypoint)', want '$id'" }

Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dist, $stage | Out-Null

$artifacts = @()
foreach ($target in $Targets) {
	$parts = $target.Split("/")
	$goos = $parts[0]
	$goarch = $parts[1]
	$binaryName = if ($goos -eq "windows") { "$id.exe" } else { $id }
	$output = Join-Path $stage $binaryName
	Write-Host "building $goos/$goarch"

	$previousGoos = $env:GOOS
	$previousGoarch = $env:GOARCH
	$previousCgo = $env:CGO_ENABLED
	try {
		$env:GOOS = $goos
		$env:GOARCH = $goarch
		$env:CGO_ENABLED = "0"
		Push-Location $root
		go build -trimpath -ldflags "-s -w" -o $output .
		if ($LASTEXITCODE -ne 0) { throw "go build failed for $goos/$goarch" }
		Pop-Location
	} finally {
		$env:GOOS = $previousGoos
		$env:GOARCH = $previousGoarch
		$env:CGO_ENABLED = $previousCgo
	}

	# The zip must carry plugin.json next to the entrypoint at its root: that is
	# what the host reads before it launches anything. The packaged entrypoint has
	# to name the file this target actually ships — Windows keeps an ".exe"
	# suffix, and the host validates the entrypoint against the extracted files.
	$packaged = $manifest
	$packaged.entrypoint = $binaryName
	$packaged | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $stage "plugin.json") -Encoding utf8NoBOM
	$zipName = "${id}_${Version}_${goos}_${goarch}.zip"
	$zipPath = Join-Path $dist $zipName
	Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -Force
	Remove-Item -Force $output

	$item = Get-Item $zipPath
	$artifacts += [pscustomobject]@{
		GOOS   = $goos
		GOARCH = $goarch
		Name   = $zipName
		SHA256 = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLower()
		Size   = $item.Length
	}
}

Remove-Item -Recurse -Force $stage

Get-ChildItem $dist -Filter "${id}_*.zip" | Format-Table Name, Length
Write-Host "`nregistry.json artifact block (paste under install.artifacts):"
$block = $artifacts | ForEach-Object {
	@"
        {
          "goos": "$($_.GOOS)",
          "goarch": "$($_.GOARCH)",
          "url": "https://raw.githubusercontent.com/ZiChuanLan/meta-gateway-plugins/main/dist/$($_.Name)",
          "sha256": "$($_.SHA256)",
          "size": $($_.Size)
        }
"@
}
Write-Host ($block -join ",`n")
Write-Host "`nverify with: python3 scripts/validate_registry.py"
