# Live Reload deploy — serves www/ from this PC and hot-reloads on the connected phone.
# Requires:  phone on same Wi-Fi as this PC, app already installed (run deployApp.ps1 once first).
# Stop with Ctrl+C when done.

$ErrorActionPreference = 'Stop'
$projectRoot = "C:\Users\Savage Cat Racing\Documents\projects\ai-active-suspension-3"
Set-Location $projectRoot

node .\build-version.js
npx cap sync android

# --external  = bind to all interfaces so the phone can reach this PC
# --no-open   = don't try to open a browser window
npx cap run android --live-reload --host 192.168.87.23 --port 3000 --forwardPorts 3000:3000
