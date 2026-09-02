[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$RepoRoot = Split-Path -Parent $PSScriptRoot
$InstallScript = Join-Path $RepoRoot "install.ps1"
$UninstallScript = Join-Path $RepoRoot "uninstall.ps1"

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )
    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
}

function Assert-PathExists {
    param(
        [string]$Path,
        [string]$Message
    )
    Assert-True -Condition (Test-Path -LiteralPath $Path) -Message $Message
}

function Assert-PathMissing {
    param(
        [string]$Path,
        [string]$Message
    )
    Assert-True -Condition (-not (Test-Path -LiteralPath $Path)) -Message $Message
}

function Assert-SamePath {
    param(
        [string]$Actual,
        [string]$Expected,
        [string]$Message
    )
    $trimCharacters = [char[]]@(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $actualFull = [System.IO.Path]::GetFullPath($Actual).TrimEnd($trimCharacters)
    $expectedFull = [System.IO.Path]::GetFullPath($Expected).TrimEnd($trimCharacters)
    Assert-True -Condition ([string]::Equals(
        $actualFull,
        $expectedFull,
        [System.StringComparison]::OrdinalIgnoreCase
    )) -Message $Message
}

function Has-Property {
    param(
        [object]$Object,
        [string]$Name
    )
    return $null -ne $Object.PSObject.Properties[$Name]
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Read-Json {
    param([string]$Path)
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Resolve-NodeExecutable {
    # `Get-Command node.exe` can return every matching PATH application under
    # Windows PowerShell 5.1. Keep its resolution order so the setup-node path
    # prepended by the runner wins, but return one validated executable string
    # instead of allowing multiple .Source values to collapse into one command.
    $nodeCandidates = @(
        Get-Command node.exe -CommandType Application -All -ErrorAction Stop
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

    throw "No absolute Node.js application executable was found on PATH."
}

function Invoke-DualogPowerShellScript {
    param(
        [string]$PowerShellExecutable,
        [string]$ScriptPath,
        [string[]]$Arguments
    )
    $launchArguments = @(
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $ScriptPath
    ) + $Arguments
    & $PowerShellExecutable @launchArguments
    $status = $LASTEXITCODE
    if ($status -ne 0) {
        throw "$ScriptPath exited with status $status"
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "This smoke test must run on native Windows."
}

$powerShellExecutable = Join-Path $PSHOME "powershell.exe"
Assert-PathExists -Path $powerShellExecutable `
    -Message "Windows PowerShell executable is unavailable under PSHOME"
$nodeExecutable = Resolve-NodeExecutable
$environmentNames = @(
    "USERPROFILE",
    "HOME",
    "CODEX_HOME",
    "DUALOG_WSL_DISTRO",
    "DUALOG_WSL_BINARY",
    "CODEX_DIALOG_WSL_DISTRO",
    "CODEX_DIALOG_WSL_BINARY",
    "CONDUCTOR_WSL_DISTRO",
    "CONDUCTOR_WSL_BINARY"
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable(
        $name,
        [System.EnvironmentVariableTarget]::Process
    )
}

$sandboxRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    "dualog-windows-installer-smoke-" + [guid]::NewGuid().ToString("N")
)
$isolatedProfile = Join-Path $sandboxRoot "User Profile With Spaces"
$isolatedCodexHome = Join-Path $sandboxRoot "Codex Home With Spaces"

try {
    New-Item -ItemType Directory -Path $isolatedProfile -Force | Out-Null
    New-Item -ItemType Directory -Path $isolatedCodexHome -Force | Out-Null
    [Environment]::SetEnvironmentVariable(
        "USERPROFILE",
        $isolatedProfile,
        [System.EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        "HOME",
        $isolatedProfile,
        [System.EnvironmentVariableTarget]::Process
    )
    [Environment]::SetEnvironmentVariable(
        "CODEX_HOME",
        $isolatedCodexHome,
        [System.EnvironmentVariableTarget]::Process
    )
    foreach ($name in $environmentNames | Where-Object { $_ -like "*WSL*" }) {
        [Environment]::SetEnvironmentVariable(
            $name,
            $null,
            [System.EnvironmentVariableTarget]::Process
        )
    }

    # Prove Node will resolve os.homedir() into the sandbox before invoking an
    # installer that writes user-scoped files.
    $nodeHomeArguments = @(
        "-e",
        "process.stdout.write(require('node:os').homedir())"
    )
    $nodeHome = & $nodeExecutable @nodeHomeArguments
    Assert-True -Condition ($LASTEXITCODE -eq 0) -Message "Node home probe failed"
    Assert-SamePath -Actual ([string]$nodeHome) -Expected $isolatedProfile `
        -Message "Node did not resolve the isolated USERPROFILE"

    $claudeDir = Join-Path $isolatedProfile ".claude"
    $claudeJsonPath = Join-Path $isolatedProfile ".claude.json"
    $claudeSettingsPath = Join-Path $claudeDir "settings.json"
    $claudeCommandsDir = Join-Path $claudeDir "commands"
    $claudeHooksDir = Join-Path $claudeDir "hooks"
    $codexConfigPath = Join-Path $isolatedCodexHome "config.toml"
    $codexSkillsDir = Join-Path $isolatedCodexHome "skills"

    $unrelatedClaudeCommand = Join-Path $claudeCommandsDir "keep-unrelated.md"
    $unrelatedClaudeHook = Join-Path $claudeHooksDir "keep-unrelated.mjs"
    $unrelatedCodexSkill = Join-Path $codexSkillsDir "keep-unrelated\SKILL.md"
    $unrelatedClaudeCommandBody = "# unrelated Claude command`n"
    $unrelatedClaudeHookBody = "// unrelated Claude hook`n"
    $unrelatedCodexSkillBody = "# unrelated Codex skill`n"

    Write-Utf8NoBom -Path $claudeJsonPath -Content @'
{
  "keepTopLevel": {
    "value": "claude-json-preserved"
  },
  "mcpServers": {
    "keep-unrelated": {
      "command": "keep-server.exe",
      "args": ["--keep"]
    }
  }
}
'@
    Write-Utf8NoBom -Path $claudeSettingsPath -Content @'
{
  "keepSetting": "claude-settings-preserved",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "KeepUnrelatedTool",
        "hooks": [
          {
            "type": "command",
            "command": "keep-unrelated.exe --flag"
          }
        ]
      }
    ]
  }
}
'@
    Write-Utf8NoBom -Path $codexConfigPath -Content @'
model = "keep-model"

[mcp_servers.keep-unrelated]
command = "keep-server.exe"
args = ["--keep"]
'@
    Write-Utf8NoBom -Path $unrelatedClaudeCommand -Content $unrelatedClaudeCommandBody
    Write-Utf8NoBom -Path $unrelatedClaudeHook -Content $unrelatedClaudeHookBody
    Write-Utf8NoBom -Path $unrelatedCodexSkill -Content $unrelatedCodexSkillBody

    Write-Host "Running native Windows PowerShell installer in isolated profile $isolatedProfile"
    Invoke-DualogPowerShellScript `
        -PowerShellExecutable $powerShellExecutable `
        -ScriptPath $InstallScript `
        -Arguments @("-Both", "-HostOnly")

    $claudeConfig = Read-Json -Path $claudeJsonPath
    Assert-True -Condition (Has-Property -Object $claudeConfig.mcpServers -Name "dualog") `
        -Message "Claude MCP registration was not installed"
    Assert-True -Condition (Has-Property -Object $claudeConfig.mcpServers -Name "keep-unrelated") `
        -Message "Installer removed the unrelated Claude MCP registration"
    Assert-True -Condition ($claudeConfig.keepTopLevel.value -eq "claude-json-preserved") `
        -Message "Installer changed unrelated Claude top-level configuration"

    $claudeRegistration = $claudeConfig.mcpServers.dualog
    Assert-PathExists -Path ([string]$claudeRegistration.command) `
        -Message "Claude MCP registration does not point at an existing Node executable"
    Assert-SamePath -Actual ([string]$claudeRegistration.command) -Expected $nodeExecutable `
        -Message "Claude MCP registration does not point at the expected Node executable"
    $claudeArguments = @($claudeRegistration.args)
    Assert-True -Condition ($claudeArguments.Count -eq 1) `
        -Message "Claude MCP registration should contain exactly one server argument"
    $expectedServerPath = Join-Path $RepoRoot "src\dialog-server.mjs"
    Assert-SamePath -Actual ([string]$claudeArguments[0]) -Expected $expectedServerPath `
        -Message "Claude MCP registration points at the wrong server"

    $codexConfig = Get-Content -LiteralPath $codexConfigPath -Raw
    Assert-True -Condition ($codexConfig -match '(?m)^\[mcp_servers\.dualog\]\s*$') `
        -Message "Codex MCP registration was not installed"
    $codexDualogSection = [regex]::Match(
        $codexConfig,
        '(?ms)^\[mcp_servers\.dualog\]\s*\r?\n(?<body>.*?)(?=^\[|\z)'
    ).Groups['body'].Value
    $codexCommandMatch = [regex]::Match(
        $codexDualogSection,
        '(?m)^command = (?<value>"(?:[^"\\]|\\.)*")\s*$'
    )
    $codexArgumentMatch = [regex]::Match(
        $codexDualogSection,
        '(?m)^args = \[(?<value>"(?:[^"\\]|\\.)*")\]\s*$'
    )
    Assert-True -Condition $codexCommandMatch.Success `
        -Message "Codex MCP registration has no valid command"
    Assert-True -Condition $codexArgumentMatch.Success `
        -Message "Codex MCP registration has no valid server argument"
    $codexCommand = $codexCommandMatch.Groups['value'].Value | ConvertFrom-Json
    $codexServerArgument = $codexArgumentMatch.Groups['value'].Value | ConvertFrom-Json
    Assert-SamePath -Actual ([string]$codexCommand) -Expected $nodeExecutable `
        -Message "Codex MCP registration does not point at the expected Node executable"
    Assert-SamePath -Actual ([string]$codexServerArgument) -Expected $expectedServerPath `
        -Message "Codex MCP registration does not point at the expected Dualog server"
    Assert-True -Condition ($codexConfig -match '(?m)^\[mcp_servers\.keep-unrelated\]\s*$') `
        -Message "Installer removed the unrelated Codex MCP registration"
    Assert-True -Condition ($codexConfig -match '(?m)^model = "keep-model"\s*$') `
        -Message "Installer changed unrelated Codex configuration"

    $claudeReviewPr = Join-Path $claudeCommandsDir "dualog-review-pr.md"
    $codexReviewPr = Join-Path $codexSkillsDir "dualog-review-pr\SKILL.md"
    Assert-PathExists -Path $claudeReviewPr `
        -Message "Claude PR-review command was not installed"
    Assert-PathExists -Path $codexReviewPr `
        -Message "Codex PR-review skill was not installed"
    Assert-True -Condition ((Get-Content -LiteralPath $claudeReviewPr -Raw) -match 'start_pr_review') `
        -Message "Claude PR-review command does not expose the PR-review toolkit"
    Assert-True -Condition ((Get-Content -LiteralPath $codexReviewPr -Raw) -match 'start_pr_review') `
        -Message "Codex PR-review skill does not expose the PR-review toolkit"

    $installedSettings = Read-Json -Path $claudeSettingsPath
    $installedPreMatchers = @($installedSettings.hooks.PreToolUse | ForEach-Object { $_.matcher })
    Assert-True -Condition ($installedPreMatchers -contains "KeepUnrelatedTool") `
        -Message "Installer removed the unrelated Claude hook registration"
    Assert-True -Condition ($installedPreMatchers -contains "mcp__dualog__send_message") `
        -Message "Installer did not register Dualog Claude hooks"
    Assert-PathExists -Path (Join-Path $claudeHooksDir "dualog") `
        -Message "Installer did not install Dualog Claude hook files"
    Assert-PathExists -Path (Join-Path $claudeHooksDir "dualog-platform.mjs") `
        -Message "Installer did not install the shared Claude platform helper"

    Write-Host "Running native Windows PowerShell uninstaller in the same isolated profile"
    Invoke-DualogPowerShellScript `
        -PowerShellExecutable $powerShellExecutable `
        -ScriptPath $UninstallScript `
        -Arguments @("-Both", "-HostOnly")

    $claudeAfter = Read-Json -Path $claudeJsonPath
    Assert-True -Condition (-not (Has-Property -Object $claudeAfter.mcpServers -Name "dualog")) `
        -Message "Uninstaller retained the owned Claude MCP registration"
    Assert-True -Condition (Has-Property -Object $claudeAfter.mcpServers -Name "keep-unrelated") `
        -Message "Uninstaller removed the unrelated Claude MCP registration"
    Assert-True -Condition ($claudeAfter.keepTopLevel.value -eq "claude-json-preserved") `
        -Message "Uninstaller changed unrelated Claude top-level configuration"

    $settingsAfter = Read-Json -Path $claudeSettingsPath
    $settingsAfterRaw = Get-Content -LiteralPath $claudeSettingsPath -Raw
    $remainingPreHooks = @($settingsAfter.hooks.PreToolUse)
    Assert-True -Condition ($settingsAfter.keepSetting -eq "claude-settings-preserved") `
        -Message "Uninstaller changed unrelated Claude settings"
    Assert-True -Condition ($remainingPreHooks.Count -eq 1) `
        -Message "Uninstaller did not preserve exactly the unrelated Claude pre-hook"
    Assert-True -Condition ($remainingPreHooks[0].matcher -eq "KeepUnrelatedTool") `
        -Message "Uninstaller changed the unrelated Claude pre-hook matcher"
    Assert-True -Condition ($remainingPreHooks[0].hooks[0].command -eq "keep-unrelated.exe --flag") `
        -Message "Uninstaller changed the unrelated Claude pre-hook command"
    Assert-True -Condition ($settingsAfterRaw -notmatch 'mcp__dualog__|dualog-platform\.mjs') `
        -Message "Uninstaller retained an owned Dualog Claude hook registration"

    $codexAfter = Get-Content -LiteralPath $codexConfigPath -Raw
    Assert-True -Condition ($codexAfter -notmatch '(?m)^\[mcp_servers\.dualog\]\s*$') `
        -Message "Uninstaller retained the owned Codex MCP registration"
    Assert-True -Condition ($codexAfter -match '(?m)^\[mcp_servers\.keep-unrelated\]\s*$') `
        -Message "Uninstaller removed the unrelated Codex MCP registration"
    Assert-True -Condition ($codexAfter -match '(?m)^model = "keep-model"\s*$') `
        -Message "Uninstaller changed unrelated Codex configuration"

    foreach ($commandName in @(
        "dualog-review-code",
        "dualog-review-pr",
        "dualog-review-plan",
        "dualog-review-spec",
        "dualog-audit"
    )) {
        Assert-PathMissing -Path (Join-Path $claudeCommandsDir "$commandName.md") `
            -Message "Uninstaller retained owned Claude command $commandName"
    }
    foreach ($skillName in @(
        "dualog-review-code",
        "dualog-review-pr",
        "dualog-review-plan",
        "dualog-review-spec",
        "dualog-audit",
        "dualog-ui-implementer"
    )) {
        Assert-PathMissing -Path (Join-Path $codexSkillsDir $skillName) `
            -Message "Uninstaller retained owned Codex skill $skillName"
    }
    Assert-PathMissing -Path (Join-Path $claudeHooksDir "dualog") `
        -Message "Uninstaller retained owned Claude hook files"
    Assert-PathMissing -Path (Join-Path $claudeHooksDir "dualog-platform.mjs") `
        -Message "Uninstaller retained the owned Claude platform helper"

    Assert-True -Condition ((Get-Content -LiteralPath $unrelatedClaudeCommand -Raw) -eq $unrelatedClaudeCommandBody) `
        -Message "Lifecycle changed the unrelated Claude command file"
    Assert-True -Condition ((Get-Content -LiteralPath $unrelatedClaudeHook -Raw) -eq $unrelatedClaudeHookBody) `
        -Message "Lifecycle changed the unrelated Claude hook file"
    Assert-True -Condition ((Get-Content -LiteralPath $unrelatedCodexSkill -Raw) -eq $unrelatedCodexSkillBody) `
        -Message "Lifecycle changed the unrelated Codex skill file"

    Write-Host "Native Windows PowerShell install/uninstall smoke test passed."
} finally {
    try {
        if (Test-Path -LiteralPath $sandboxRoot) {
            Remove-Item -LiteralPath $sandboxRoot -Recurse -Force
        }
    } finally {
        foreach ($name in $environmentNames) {
            [Environment]::SetEnvironmentVariable(
                $name,
                $originalEnvironment[$name],
                [System.EnvironmentVariableTarget]::Process
            )
        }
    }
}
