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
$InstallArgs = @()
$Targets = @($Claude, $Codex, $Both) | Where-Object { $_ }

if ($Targets.Count -gt 1) {
    throw "Choose only one of -Claude, -Codex, or -Both."
}

if ($Claude) {
    $InstallArgs += "--claude"
} elseif ($Codex) {
    $InstallArgs += "--codex"
} elseif ($Both) {
    $InstallArgs += "--both"
}

if ($HostOnly) {
    $InstallArgs += "--host-only"
}
if ($PSBoundParameters.ContainsKey("Distro")) {
    $InstallArgs += @("--wsl-distro", $Distro)
}
if ($PSBoundParameters.ContainsKey("WslBinary")) {
    $InstallArgs += @("--wsl-binary", $WslBinary)
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

    & $NodeCommand.Source (Join-Path $ScriptDir "scripts/install.mjs") @InstallArgs
    $ExitCode = $LASTEXITCODE
} finally {
    [Environment]::SetEnvironmentVariable("DUALOG_WSL_DISTRO", $PreviousDistro, "Process")
    [Environment]::SetEnvironmentVariable("DUALOG_WSL_BINARY", $PreviousWslBinary, "Process")
}
exit $ExitCode
