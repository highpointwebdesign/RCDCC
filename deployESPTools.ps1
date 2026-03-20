##############################################################################
# deployESPTools.ps1
#
# Direct esptool.py flash script for the RCDCC ESP32.
# Use this when PlatformIO's deployFirmware.ps1 fails to flash.
#
# USAGE EXAMPLES
#   # Auto-detect COM port, build first, then flash everything:
#   .\deployESPTools.ps1
#
#   # Specify COM port, skip rebuild:
#   .\deployESPTools.ps1 -Port COM4 -SkipBuild
#
#   # Erase all flash first (fixes corrupted NVS / stuck-boot issues):
#   .\deployESPTools.ps1 -EraseAll
#
#   # Flash firmware + LittleFS filesystem image:
#   .\deployESPTools.ps1 -IncludeFilesystem
#
#   # Just open the serial monitor after flashing:
#   .\deployESPTools.ps1 -SkipBuild -Monitor
#
#   # List available COM ports:
#   .\deployESPTools.ps1 -ListPorts
##############################################################################

[CmdletBinding()]
param(
    [string]$Port,                      # e.g. COM4 — auto-detected if omitted
    [switch]$SkipBuild,                 # Skip PlatformIO compile step
    [switch]$EraseAll,                  # Full chip erase before flashing
    [switch]$IncludeFilesystem,         # Also flash the LittleFS image
    [switch]$Monitor,                   # Open serial monitor after flashing
    [int]$Baud = 115200,                # Upload baud rate
    [int]$MonitorBaud = 115200,         # Serial monitor baud rate
    [switch]$ListPorts,                 # Print available COM ports and exit
    [string]$Environment = 'esp32'      # PlatformIO environment name
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Paths ─────────────────────────────────────────────────────────────────────
$projectRoot  = Split-Path -Parent $PSCommandPath
$firmwareDir  = Join-Path $projectRoot 'firmware'
$buildDir     = Join-Path $firmwareDir ".pio\build\$Environment"

$firmwareBin  = Join-Path $buildDir 'firmware.bin'
$bootloaderBin= Join-Path $buildDir 'bootloader.bin'
$partitionsBin= Join-Path $buildDir 'partitions.bin'
$littlefsBin  = Join-Path $buildDir 'littlefs.bin'  # produced by pio run -t buildfs

# Fixed flash addresses for ESP32 (matches PlatformIO defaults + custom partition table)
$ADDR_BOOTLOADER  = '0x1000'
$ADDR_PARTITIONS  = '0x8000'
$ADDR_APP         = '0x10000'
$ADDR_LITTLEFS    = '0x2F0000'  # matches partitions_rcdcc.csv littlefs offset

# ── Helper: write status messages ─────────────────────────────────────────────
function Write-Step([string]$msg) {
    Write-Host "`n>>> $msg" -ForegroundColor Cyan
}
function Write-OK([string]$msg) {
    Write-Host "    [OK] $msg" -ForegroundColor Green
}
function Write-Warn([string]$msg) {
    Write-Host "    [WARN] $msg" -ForegroundColor Yellow
}
function Fail([string]$msg) {
    Write-Host "`n[FAIL] $msg" -ForegroundColor Red
    exit 1
}

# ── Locate esptool ────────────────────────────────────────────────────────────
function Find-Esptool {
    # 1. esptool.py on PATH
    foreach ($cmd in @('esptool.py', 'esptool')) {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) { return $cmd }
    }

    # 2. PlatformIO's bundled esptool (Windows typical paths)
    $pioPkgRoots = @(
        "$env:USERPROFILE\.platformio\packages\tool-esptoolpy",
        "$env:USERPROFILE\.platformio\packages\tool-esptool-ck",
        "$env:LOCALAPPDATA\Programs\platformio\packages\tool-esptoolpy"
    )
    foreach ($root in $pioPkgRoots) {
        $candidate = Join-Path $root 'esptool.py'
        if (Test-Path $candidate) { return "python `"$candidate`"" }
    }

    # 3. pip-installed esptool module
    if (Get-Command python -ErrorAction SilentlyContinue) {
        $check = python -c "import esptool; print(esptool.__file__)" 2>$null
        if ($LASTEXITCODE -eq 0) { return 'python -m esptool' }
    }

    return $null
}

# ── Locate PlatformIO CLI ─────────────────────────────────────────────────────
function Find-Pio {
    foreach ($cmd in @('pio', 'platformio')) {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) { return $cmd }
    }
    return $null
}

# ── Auto-detect a single ESP32 COM port ───────────────────────────────────────
function Find-ESP32Port {
    $candidates = Get-WmiObject Win32_PnPEntity -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -match 'CP210|CH340|FTDI|Silicon Lab|USB-SERIAL|ESP32' -and
            $_.Name -match 'COM\d+'
        } |
        ForEach-Object { if ($_.Name -match '(COM\d+)') { $matches[1] } } |
        Select-Object -Unique

    if (@($candidates).Count -eq 1) { return $candidates }
    if (@($candidates).Count -gt 1) { return $candidates[0] }  # pick first
    return $null
}

# ══════════════════════════════════════════════════════════════════════════════
# LIST PORTS
# ══════════════════════════════════════════════════════════════════════════════
if ($ListPorts) {
    Write-Host "Available serial ports:" -ForegroundColor Cyan
    Get-WmiObject Win32_PnPEntity -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'COM\d+' } |
        ForEach-Object { Write-Host "  $($_.Name)" }
    exit 0
}

# ══════════════════════════════════════════════════════════════════════════════
# VALIDATE FIRMWARE DIR
# ══════════════════════════════════════════════════════════════════════════════
if (-not (Test-Path $firmwareDir)) {
    Fail "Firmware directory not found: $firmwareDir"
}

$bumpScriptPath = Join-Path $projectRoot 'bump-firmware-version.js'

# ══════════════════════════════════════════════════════════════════════════════
# BUILD (optional)
# ══════════════════════════════════════════════════════════════════════════════
if (-not $SkipBuild) {
    $pioCmd = Find-Pio
    if (-not $pioCmd) {
        Fail "PlatformIO CLI ('pio') not found. Install it or use -SkipBuild if binaries already exist."
    }

    if (-not (Test-Path $bumpScriptPath)) {
        Fail "Firmware version bump script not found: $bumpScriptPath"
    }

    Write-Step "Incrementing firmware version..."
    & node $bumpScriptPath
    if ($LASTEXITCODE -ne 0) { Fail "Firmware version increment failed." }

    Write-Step "Building firmware (pio run -e $Environment)..."
    Push-Location $firmwareDir
    try {
        & $pioCmd run -e $Environment
        if ($LASTEXITCODE -ne 0) { Fail "PlatformIO build failed." }
    } finally { Pop-Location }
    Write-OK "Build successful."

    if ($IncludeFilesystem) {
        Write-Step "Building LittleFS filesystem image (pio run -t buildfs)..."
        Push-Location $firmwareDir
        try {
            & $pioCmd run -e $Environment -t buildfs
            if ($LASTEXITCODE -ne 0) { Fail "LittleFS build failed." }
        } finally { Pop-Location }
        Write-OK "Filesystem image built."
    }
}

# ══════════════════════════════════════════════════════════════════════════════
# VALIDATE BINARIES
# ══════════════════════════════════════════════════════════════════════════════
foreach ($f in @($firmwareBin, $bootloaderBin, $partitionsBin)) {
    if (-not (Test-Path $f)) {
        Fail "Required binary not found: $f`nRun without -SkipBuild, or run 'pio run -e $Environment' first."
    }
}

if ($IncludeFilesystem -and -not (Test-Path $littlefsBin)) {
    Fail "LittleFS image not found: $littlefsBin`nRun without -SkipBuild, or run 'pio run -e $Environment -t buildfs' first."
}

# ══════════════════════════════════════════════════════════════════════════════
# LOCATE ESPTOOL
# ══════════════════════════════════════════════════════════════════════════════
$espToolRaw = Find-Esptool
if (-not $espToolRaw) {
    Fail "esptool not found.`nTry: pip install esptool`nOr install PlatformIO which bundles it."
}
Write-OK "esptool found: $espToolRaw"

# ══════════════════════════════════════════════════════════════════════════════
# DETECT COM PORT
# ══════════════════════════════════════════════════════════════════════════════
if (-not $Port) {
    Write-Step "Auto-detecting ESP32 COM port..."
    $Port = Find-ESP32Port
    if ($Port) {
        Write-OK "Found: $Port"
    } else {
        Write-Warn "Could not auto-detect port. Common ports: COM3, COM4, COM5, COM6"
        $Port = Read-Host "Enter COM port (e.g. COM4)"
        if (-not $Port) { Fail "No COM port specified." }
    }
}

Write-Host "`n  Target port : $Port" -ForegroundColor White
Write-Host "  Baud rate   : $Baud" -ForegroundColor White
Write-Host "  Firmware    : $firmwareBin" -ForegroundColor White

# ══════════════════════════════════════════════════════════════════════════════
# ERASE ALL FLASH (optional but useful for stuck devices)
# ══════════════════════════════════════════════════════════════════════════════
if ($EraseAll) {
    Write-Step "Erasing entire flash chip (removes NVS, LittleFS, firmware)..."
    $eraseCmd = "$espToolRaw --chip esp32 --port $Port --baud $Baud erase_flash"
    Write-Host "  CMD: $eraseCmd" -ForegroundColor DarkGray
    Invoke-Expression $eraseCmd
    if ($LASTEXITCODE -ne 0) { Fail "Flash erase failed (exit $LASTEXITCODE)." }
    Write-OK "Flash erased."
    Start-Sleep -Milliseconds 500
}

# ══════════════════════════════════════════════════════════════════════════════
# FLASH
# ══════════════════════════════════════════════════════════════════════════════
Write-Step "Flashing ESP32..."

# Assemble the write_flash command.
# --no-stub can help on some boards where the software loader hangs.
$flashArgs = @(
    '--chip', 'esp32',
    '--port', $Port,
    '--baud', $Baud,
    '--before', 'default_reset',
    '--after', 'hard_reset',
    'write_flash',
    '--flash_mode', 'dio',
    '--flash_freq', '40m',
    '--flash_size', 'detect',
    $ADDR_BOOTLOADER, "`"$bootloaderBin`"",
    $ADDR_PARTITIONS, "`"$partitionsBin`"",
    $ADDR_APP,        "`"$firmwareBin`""
)

if ($IncludeFilesystem) {
    $flashArgs += @($ADDR_LITTLEFS, "`"$littlefsBin`"")
    Write-Host "  Includes LittleFS @ $ADDR_LITTLEFS" -ForegroundColor DarkGray
}

$fullCmd = "$espToolRaw " + ($flashArgs -join ' ')
Write-Host "  CMD: $fullCmd" -ForegroundColor DarkGray

Invoke-Expression $fullCmd
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nFlash failed. Troubleshooting tips:" -ForegroundColor Yellow
    Write-Host "  1. Hold BOOT button on ESP32 while the script starts connecting." -ForegroundColor Yellow
    Write-Host "  2. Try a lower baud rate:  .\deployESPTools.ps1 -Baud 460800 -Port $Port" -ForegroundColor Yellow
    Write-Host "  3. Full erase first:       .\deployESPTools.ps1 -EraseAll -Port $Port" -ForegroundColor Yellow
    Write-Host "  4. Try --no-stub option:   edit this script and add '--no-stub' to flashArgs" -ForegroundColor Yellow
    Write-Host "  5. Check the USB cable (data cable, not charge-only)." -ForegroundColor Yellow
    Fail "esptool write_flash failed (exit $LASTEXITCODE)."
}

Write-OK "Firmware flashed successfully!"

# ══════════════════════════════════════════════════════════════════════════════
# SERIAL MONITOR (optional)
# ══════════════════════════════════════════════════════════════════════════════
if ($Monitor) {
    Write-Step "Opening serial monitor at $MonitorBaud baud (Ctrl+C to exit)..."
    Start-Sleep -Milliseconds 800  # give ESP32 time to boot

    $pioCmd = Find-Pio
    if ($pioCmd) {
        & $pioCmd device monitor --port $Port --baud $MonitorBaud
    } else {
        # Fallback: use esptool's built-in monitor (limited but works)
        Invoke-Expression "$espToolRaw --port $Port --baud $MonitorBaud monitor"
    }
}
