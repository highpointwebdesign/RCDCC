[CmdletBinding()]
param(
    [string]$TargetDevice
)

$ErrorActionPreference = 'Stop'

$projectRoot = "C:\Users\Savage Cat Racing\Documents\projects\ai-active-suspension-3"
Push-Location $projectRoot
try {
    # Some shells persist JAVA_HOME as a java.exe path. Normalize it to a JDK root for Gradle.
    if ($env:JAVA_HOME) {
        $javaHome = $env:JAVA_HOME.Trim('"')
        if ($javaHome -match '[\\/]bin[\\/]java\.exe$') {
            $javaHome = Split-Path (Split-Path $javaHome -Parent) -Parent
        } elseif ($javaHome -match '[\\/]bin$') {
            $javaHome = Split-Path $javaHome -Parent
        }
        if (Test-Path (Join-Path $javaHome 'bin\java.exe')) {
            $env:JAVA_HOME = $javaHome
        }
    }

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
}
finally {
    Pop-Location
    Write-Host ("Last app update attempt: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Green -BackgroundColor Black
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
