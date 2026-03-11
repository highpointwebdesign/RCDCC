$ErrorActionPreference = 'Stop'

$projectRoot = "C:\Users\Savage Cat Racing\Documents\projects\ai-active-suspension-3"
Set-Location $projectRoot

npx cap sync android

Set-Location (Join-Path $projectRoot 'android')
.\gradlew.bat assembleDebug

$apk = Join-Path $projectRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
adb install -r -d -t "$apk"

# Relaunch app after install
$appId = 'com.rcdcc.app'
adb shell monkey -p $appId -c android.intent.category.LAUNCHER 1 | Out-Null

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