[CmdletBinding()]
param(
	[string]$Environment = 'esp32',
	[string]$UploadPort,
	[switch]$SkipBuild,
	[switch]$Monitor,
	[int]$MonitorBaud = 460800,
	[switch]$ListPorts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSCommandPath
$firmwareDir = Join-Path $projectRoot 'firmware'

if (-not (Test-Path $firmwareDir)) {
	throw "Firmware directory not found: $firmwareDir"
}

$bumpScriptPath = Join-Path $projectRoot 'bump-firmware-version.js'

$pioCommand = $null
if (Get-Command 'pio' -ErrorAction SilentlyContinue) {
	$pioCommand = 'pio'
} elseif (Get-Command 'platformio' -ErrorAction SilentlyContinue) {
	$pioCommand = 'platformio'
} else {
	throw "PlatformIO CLI not found. Install PlatformIO Core and ensure 'pio' is on PATH."
}

Push-Location $firmwareDir
try {
	if ($ListPorts) {
		& $pioCommand device list
		if ($LASTEXITCODE -ne 0) {
			throw "Failed to list serial ports."
		}
		return
	}

	if (-not $SkipBuild) {
		if (-not (Test-Path $bumpScriptPath)) {
			throw "Firmware version bump script not found: $bumpScriptPath"
		}

		Write-Host "Incrementing firmware version..."
		& node $bumpScriptPath
		if ($LASTEXITCODE -ne 0) {
			throw "Firmware version increment failed."
		}

		Write-Host "Building firmware for environment '$Environment'..."
		& $pioCommand run -e $Environment
		if ($LASTEXITCODE -ne 0) {
			throw "Firmware build failed for environment '$Environment'."
		}
	}

	$eraseArgs = @('run', '-e', $Environment, '--target', 'erase')
	if ($UploadPort) {
		$eraseArgs += @('--upload-port', $UploadPort)
	}

	Write-Host "Erasing flash..."
	& $pioCommand @eraseArgs
	if ($LASTEXITCODE -ne 0) {
		throw "Flash erase failed."
	}

	$uploadArgs = @('run', '-e', $Environment, '--target', 'upload')
	if ($UploadPort) {
		$uploadArgs += @('--upload-port', $UploadPort)
	}

	Write-Host "Uploading firmware..."
	& $pioCommand @uploadArgs
	if ($LASTEXITCODE -ne 0) {
		throw "Firmware upload failed."
	}

	Write-Host "Firmware upload complete."

	if ($Monitor) {
		$monitorArgs = @('device', 'monitor', '--baud', $MonitorBaud)
		if ($UploadPort) {
			$monitorArgs += @('--port', $UploadPort)
		}

		Write-Host "Starting serial monitor at $MonitorBaud baud..."
		& $pioCommand @monitorArgs
		if ($LASTEXITCODE -ne 0) {
			throw "Serial monitor exited with an error."
		}
	}
}
finally {
	Pop-Location
}
