# codex-profiles Windows Installer
# Run: irm https://raw.githubusercontent.com/reimurashiki/codex-profiles-windows/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

$Repo = "reimurashiki/codex-profiles-windows"
$InstallDir = if ($env:CODEX_PROFILE_INSTALL_DIR) { $env:CODEX_PROFILE_INSTALL_DIR } else { "$env:LOCALAPPDATA\codex-profiles" }
$BinDir = "$InstallDir\bin"

Write-Host "Installing codex-profiles for Windows..." -ForegroundColor Cyan

if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

$BaseUrl = "https://raw.githubusercontent.com/$Repo/main"

Invoke-WebRequest -Uri "$BaseUrl/bin/codex-profile.js" -OutFile "$BinDir\codex-profile.js" -UseBasicParsing
Invoke-WebRequest -Uri "$BaseUrl/bin/codex-profile.cmd" -OutFile "$BinDir\codex-profile.cmd" -UseBasicParsing
Invoke-WebRequest -Uri "$BaseUrl/bin/codex-profiles.cmd" -OutFile "$BinDir\codex-profiles.cmd" -UseBasicParsing

# Check if BinDir is in User PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
if ($UserPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$BinDir", [EnvironmentVariableTarget]::User)
    $env:Path = "$env:Path;$BinDir"
    Write-Host "Added $BinDir to User PATH." -ForegroundColor Green
}

Write-Host "Installation completed successfully!" -ForegroundColor Green
Write-Host "Run 'codex-profile doctor' to verify." -ForegroundColor Yellow
