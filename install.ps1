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

function Resolve-NodeExecutable {
    # Windows PowerShell 5.1 can return every matching PATH application here.
    # Preserve command-resolution order so a setup-node path prepended to PATH
    # wins, but return one validated executable string rather than an array.
    $nodeCandidates = @(
        Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue
    )
    foreach ($candidate in $nodeCandidates) {
        if ($candidate.CommandType -ne [System.Management.Automation.CommandTypes]::Application) {
            continue
        }
        $source = [string]$candidate.Source
        if ([string]::IsNullOrWhiteSpace($source)) {
            continue
        }

        # Path.IsPathRooted accepts drive-relative `C:node.exe`, so require an
        # ordinary drive-absolute or fully rooted UNC spelling explicitly.
        $isDriveAbsolute = $source -match '^[A-Za-z]:[\\/]'
        $isUncAbsolute = $source -match '^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]'
        if (-not ($isDriveAbsolute -or $isUncAbsolute)) {
            continue
        }

        try {
            $fullPath = [System.IO.Path]::GetFullPath($source)
        } catch {
            continue
        }
        if (-not [string]::Equals(
            [System.IO.Path]::GetFileName($fullPath),
            "node.exe",
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            continue
        }
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            continue
        }
        return $fullPath
    }

    return $null
}

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

$NodeExecutable = Resolve-NodeExecutable
if (-not $NodeExecutable) {
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

    $NodeArguments = @((Join-Path $ScriptDir "scripts/install.mjs")) + $InstallArgs
    & $NodeExecutable @NodeArguments
    $ExitCode = $LASTEXITCODE
} finally {
    [Environment]::SetEnvironmentVariable("DUALOG_WSL_DISTRO", $PreviousDistro, "Process")
    [Environment]::SetEnvironmentVariable("DUALOG_WSL_BINARY", $PreviousWslBinary, "Process")
}
exit $ExitCode
