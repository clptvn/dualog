param(
    [switch]$Claude,
    [switch]$Codex,
    [switch]$Both,
    [switch]$HostOnly,
    [ValidateNotNullOrEmpty()]
    [string]$Distro,
    [ValidateNotNullOrEmpty()]
    [string]$WslBinary
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$UninstallArgs = @()
$Targets = @($Claude, $Codex, $Both) | Where-Object { $_ }

if ($Targets.Count -gt 1) {
    throw "Choose only one of -Claude, -Codex, or -Both."
}

if ($Claude) {
    $UninstallArgs += "--claude"
} elseif ($Codex) {
    $UninstallArgs += "--codex"
} elseif ($Both) {
    $UninstallArgs += "--both"
}

if ($HostOnly) {
    $UninstallArgs += "--host-only"
}
if ($PSBoundParameters.ContainsKey("Distro")) {
    $UninstallArgs += @("--wsl-distro", $Distro)
}
if ($PSBoundParameters.ContainsKey("WslBinary")) {
    $UninstallArgs += @("--wsl-binary", $WslBinary)
}

$NodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
    throw "Node.js >= 18 is required. Install Node.js and rerun this script."
}

$PreviousDistro = [Environment]::GetEnvironmentVariable("DUALOG_WSL_DISTRO", "Process")
$PreviousWslBinary = [Environment]::GetEnvironmentVariable("DUALOG_WSL_BINARY", "Process")
$ExitCode = 1
try {
    if ($PSBoundParameters.ContainsKey("Distro")) {
        [Environment]::SetEnvironmentVariable("DUALOG_WSL_DISTRO", $Distro, "Process")
    }
    if ($PSBoundParameters.ContainsKey("WslBinary")) {
        [Environment]::SetEnvironmentVariable("DUALOG_WSL_BINARY", $WslBinary, "Process")
    }

    & $NodeCommand.Source (Join-Path $ScriptDir "scripts/uninstall.mjs") @UninstallArgs
    $ExitCode = $LASTEXITCODE
} finally {
    [Environment]::SetEnvironmentVariable("DUALOG_WSL_DISTRO", $PreviousDistro, "Process")
    [Environment]::SetEnvironmentVariable("DUALOG_WSL_BINARY", $PreviousWslBinary, "Process")
}
exit $ExitCode
