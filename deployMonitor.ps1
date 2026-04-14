param(
	[string]$Port = "COM7",
	[int]$Baud = 115200,
	[string]$Environment = "esp32"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$firmwareDir = Join-Path $repoRoot "firmware"

Write-Host "Cleaning stale PlatformIO monitor processes for $Port..."
$staleMonitors = Get-CimInstance Win32_Process | Where-Object {
	$_.ProcessId -ne $PID -and
	$_.CommandLine -and (
		$_.CommandLine -match "device\s+monitor\s+--port\s+$Port\b" -or
		$_.CommandLine -match "run\s+-e\s+\S+\s+-t\s+monitor"
	)
}

if ($staleMonitors) {
	foreach ($proc in $staleMonitors) {
		try {
			Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
			Write-Host "Stopped PID $($proc.ProcessId): $($proc.Name)"
		}
		catch {
			Write-Warning "Could not stop PID $($proc.ProcessId): $($_.Exception.Message)"
		}
	}
}
else {
	Write-Host "No stale monitor processes found."
}

Push-Location $firmwareDir
try {
	pio device monitor --port $Port --baud $Baud
}
finally {
	Pop-Location
}
