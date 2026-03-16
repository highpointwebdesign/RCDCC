param(
    [string]$DeviceSerial,
    [int]$Port = 5555,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$projectRoot = "C:\Users\Savage Cat Racing\Documents\projects\ai-active-suspension-3"
Set-Location $projectRoot

function Get-WirelessDeviceSerials {
    $lines = adb devices
    if (-not $lines) { return @() }

    $serials = @()
    foreach ($line in $lines) {
        if ($line -match '^(\d{1,3}(?:\.\d{1,3}){3}:\d+)\s+device$') {
            $serials += $Matches[1]
        }
    }
    return $serials
}

if (-not $SkipBuild) {
    node .\build-version.js
    npx cap sync android

    Set-Location (Join-Path $projectRoot 'android')
    .\gradlew.bat assembleDebug
    Set-Location $projectRoot
}

# If an IP was provided without a port, append the requested port and connect.
if ($DeviceSerial) {
    if ($DeviceSerial -notmatch ':') {
        $DeviceSerial = "$DeviceSerial`:$Port"
    }

    adb connect $DeviceSerial | Out-Host
    Start-Sleep -Seconds 1
}

# If no serial was provided, use the first wireless device already connected.
if (-not $DeviceSerial) {
    $wireless = Get-WirelessDeviceSerials
    if ($wireless.Count -eq 0) {
        throw "No wireless ADB device found. Run: adb connect <phone-ip>:<port> (or pass -DeviceSerial)."
    }
    $DeviceSerial = $wireless[0]
}

$apk = Join-Path $projectRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path $apk)) {
    throw "APK not found at $apk"
}

adb -s $DeviceSerial install -r -d -t "$apk"

# Relaunch app after install
$appId = 'com.rcdcc.app'
adb -s $DeviceSerial shell monkey -p $appId -c android.intent.category.LAUNCHER 1 | Out-Null

Write-Host "Deployed to $DeviceSerial" -ForegroundColor Green
