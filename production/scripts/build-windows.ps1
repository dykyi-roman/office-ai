# ──────────────────────────────────────────────────────────────
# OfficeAI — Windows Production Build Script
# Builds: .msi + NSIS installer (.exe)
# ──────────────────────────────────────────────────────────────
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = (Resolve-Path "$ScriptDir\..\..").Path
$OutputDir = "$RootDir\production\output\windows"
$Version = (Get-Content "$RootDir\package.json" -Raw | ConvertFrom-Json).version

function Write-Info  { param($Msg) Write-Host "[INFO] $Msg" -ForegroundColor Green }
function Write-Warn  { param($Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Err   { param($Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red; exit 1 }

# ─── Preflight checks ────────────────────────────────────────
Write-Info "OfficeAI Windows build v$Version"

if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) { Write-Err "Node.js is not installed" }
if (-not (Get-Command "cargo" -ErrorAction SilentlyContinue)) { Write-Err "Rust/Cargo is not installed" }
if (-not (Get-Command "npm" -ErrorAction SilentlyContinue)) { Write-Err "npm is not installed" }

$NodeVersion = [int](node -v).Replace("v","").Split(".")[0]
if ($NodeVersion -lt 22) { Write-Err "Node.js >= 22 required (found: $(node -v))" }

$RustVersion = (rustc --version).Split(" ")[1]
Write-Info "Node.js $(node -v) | Rust $RustVersion"

# ─── Check WebView2 ──────────────────────────────────────────
$WebView2Key = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
if (-not (Test-Path $WebView2Key)) {
    Write-Warn "WebView2 Runtime not detected in registry"
    Write-Warn "NSIS installer will include WebView2 bootstrapper automatically"
}

# ─── Optional: code signing ──────────────────────────────────
$SignCert = $env:WINDOWS_SIGN_CERT
$SignPassword = $env:WINDOWS_SIGN_PASSWORD

if ($SignCert) {
    Write-Info "Code signing certificate found"
} else {
    Write-Warn "No WINDOWS_SIGN_CERT set — building unsigned"
}

# ─── Install dependencies ────────────────────────────────────
Write-Info "Installing Node.js dependencies..."
Set-Location $RootDir
npm ci

# ─── Build targets ────────────────────────────────────────────
$Formats = if ($env:BUILD_FORMATS) { $env:BUILD_FORMATS } else { "all" }

$BuildArgs = @()
switch ($Formats) {
    "all"  { $BuildArgs += "--bundles", "msi", "nsis"; Write-Info "Building: .msi + NSIS .exe" }
    "msi"  { $BuildArgs += "--bundles", "msi"; Write-Info "Building: .msi only" }
    "nsis" { $BuildArgs += "--bundles", "nsis"; Write-Info "Building: NSIS .exe only" }
}

# ─── Build ────────────────────────────────────────────────────
Write-Info "Building production app..."
npx tauri build @BuildArgs

# ─── Collect artifacts ────────────────────────────────────────
Write-Info "Collecting build artifacts..."
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$BundleDir = "$RootDir\src-tauri\target\release\bundle"

# Copy MSI
$MsiFiles = Get-ChildItem "$BundleDir\msi\*.msi" -ErrorAction SilentlyContinue
foreach ($f in $MsiFiles) {
    Copy-Item $f.FullName $OutputDir
    Write-Info "MSI copied: $($f.Name)"
}

# Copy NSIS
$NsisFiles = Get-ChildItem "$BundleDir\nsis\*.exe" -ErrorAction SilentlyContinue
foreach ($f in $NsisFiles) {
    Copy-Item $f.FullName $OutputDir
    Write-Info "NSIS installer copied: $($f.Name)"
}

# ─── Code signing (optional) ─────────────────────────────────
if ($SignCert -and $SignPassword) {
    Write-Info "Signing artifacts..."
    $Artifacts = Get-ChildItem "$OutputDir\*" -Include "*.msi","*.exe"
    foreach ($f in $Artifacts) {
        & signtool sign /f $SignCert /p $SignPassword /fd sha256 /tr "http://timestamp.digicert.com" /td sha256 $f.FullName
        Write-Info "Signed: $($f.Name)"
    }
}

# ─── Generate checksums ──────────────────────────────────────
Write-Info "Generating checksums..."
$ChecksumFile = "$OutputDir\SHA256SUMS.txt"
$Files = Get-ChildItem "$OutputDir\*" -Include "*.msi","*.exe"
$Checksums = foreach ($f in $Files) {
    $Hash = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
    "$Hash  $($f.Name)"
}
$Checksums | Out-File -FilePath $ChecksumFile -Encoding utf8
Write-Info "Checksums written to SHA256SUMS.txt"

# ─── Summary ──────────────────────────────────────────────────
Write-Info "Windows build complete!"
Write-Host ""
Write-Host "  Artifacts in: $OutputDir"
Get-ChildItem $OutputDir | ForEach-Object {
    $Size = "{0:N1} MB" -f ($_.Length / 1MB)
    Write-Host "    $($_.Name)  ($Size)"
}
Write-Host ""
Write-Host "  Install: run the .exe (NSIS) or .msi installer"
