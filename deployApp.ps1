[CmdletBinding()]
param(
    [string]$TargetDevice
)

$ErrorActionPreference = 'Stop'

$projectRoot = "C:\Users\Savage Cat Racing\Documents\projects\ai-active-suspension-3"
Set-Location $projectRoot

node .\build-version.js
npx cap sync android

Set-Location (Join-Path $projectRoot 'android')
.\gradlew.bat assembleDebug

$apk = Join-Path $projectRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
$appId = 'com.rcdcc.app'

# Install and launch on connected devices, or a specific target when requested.
$allDeviceLines = adb devices | Select-String 'device$'
if (-not $allDeviceLines) {
    Write-Warning "No ADB devices connected. Skipping install."
} else {
    $targetSerials = @($allDeviceLines | ForEach-Object {
        ($_ -split '\s+')[0].Trim()
    })

    if ($TargetDevice) {
        $targetSerials = @($targetSerials | Where-Object { $_ -eq $TargetDevice })
        if (-not $targetSerials) {
            throw "Requested target device '$TargetDevice' is not connected via ADB."
        }
    }

    foreach ($serial in $targetSerials) {
        Write-Host "Installing on $serial ..."
        adb -s $serial install -r -d -t "$apk"
        adb -s $serial shell monkey -p $appId -c android.intent.category.LAUNCHER 1 | Out-Null
        Write-Host "Done: $serial"
    }
}

# Open WebView inspector page (best effort)
# Start-Sleep -Seconds 2
# $chromePath = Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'
# $edgePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
#
# if (Test-Path $chromePath) {
# 	Start-Process $chromePath 'chrome://inspect/#devices'
# } elseif (Test-Path $edgePath) {
# 	Start-Process $edgePath 'edge://inspect/#devices'
# } else {
# 	Start-Process 'chrome://inspect/#devices'
# }

cd ..