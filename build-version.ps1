# Build Script: Auto-generate App Version from Git
# Usage: ./build-version.ps1
# This script updates APP_VERSION and BUILD_DATE in html/index.html based on git information

# Get git version (most recent tag, or commit hash if no tags)
try {
    $gitVersion = git describe --tags --always 2>$null
    if (-not $gitVersion) {
        $gitVersion = git rev-parse --short HEAD 2>$null
    }
    if (-not $gitVersion) {
        $gitVersion = "1.0.0"
    }
} catch {
    $gitVersion = "1.0.0"
}

# Get current date in YYYY-MM-DD format
$buildDate = Get-Date -Format "yyyy-MM-dd"

# HTML file path
$htmlFile = "html/index.html"

if (-not (Test-Path $htmlFile)) {
    Write-Error "Error: Could not find $htmlFile"
    exit 1
}

# Read the file
$content = Get-Content $htmlFile -Raw

# Update APP_VERSION
$content = $content -replace "const APP_VERSION = '.*?'", "const APP_VERSION = '$gitVersion'"

# Update BUILD_DATE
$content = $content -replace "const BUILD_DATE = '.*?'", "const BUILD_DATE = '$buildDate'"

# Write back to file
Set-Content $htmlFile $content -NoNewline

Write-Host "Version updated successfully"
Write-Host "  App Version: $gitVersion"
Write-Host "  Build Date:  $buildDate"
Write-Host "  File: $htmlFile"
