#Requires -Version 5.1
<#
.SYNOPSIS
  High-performance H.264 stream agent for the Computer plugin (Windows).
  Installs Gyan ffmpeg + Python 3.12 (winget), a dedicated venv, hiperf-agent.py,
  and a Scheduled Task that runs as the interactive installing user.

.NOTES
  Must run elevated (Administrator). Self-elevates via Start-Process -Verb RunAs.
  Idempotent. LAN / Tailscale only. TCP 6090 on the Private firewall profile.

  Deliberate delta from connect-windows.ps1: the task is NOT SYSTEM / AtStartup.
  Desktop capture (ddagrab / gdigrab) needs the interactive user session.
#>

param(
    [string]$Bind = ''
)

$ErrorActionPreference = 'Stop'
$ListenPort = 6090
$TaskName = 'ComputerViewerHiperf'
$FirewallName = 'Computer Viewer hiperf (6090)'
$RawRepoUrl = 'https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.09.1/computer-viewer'
$StateDir = Join-Path $env:ProgramData 'hermes-cv'
$HiperfDir = Join-Path $StateDir 'hiperf'
$VenvDir = Join-Path $HiperfDir 'venv'
$AgentPath = Join-Path $HiperfDir 'hiperf-agent.py'
$TokenFile = Join-Path $StateDir 'hiperf-token.txt'
$LogFile = Join-Path $StateDir 'hiperf.log'
$WebsocketsPin = 'websockets>=13,<16'

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal $id
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Step([string]$Message) {
    Write-Host "==> $Message"
}

if (-not (Test-IsAdmin)) {
    Write-Step 'Not elevated; relaunching as Administrator (UAC prompt)...'
    $file = $PSCommandPath
    if (-not $file) {
        # irm | iex has no path; persist the scriptblock so -Verb RunAs can -File it.
        $file = Join-Path $env:TEMP 'computer-viewer-hiperf-windows.ps1'
        $text = $null
        if ($MyInvocation.MyCommand.ScriptBlock) {
            $text = $MyInvocation.MyCommand.ScriptBlock.ToString()
        } else {
            $text = $MyInvocation.MyCommand.Definition
        }
        Set-Content -LiteralPath $file -Value $text -Encoding UTF8
    }
    try {
        $argList = @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $file
        )
        if ($Bind) { $argList += @('-Bind', $Bind) }
        $proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -PassThru -Wait -ArgumentList $argList
        if ($null -ne $proc) { exit $proc.ExitCode }
        exit 0
    } catch {
        Write-Error "Could not relaunch elevated: $_`nRun this script in an Administrator PowerShell."
        exit 1
    }
}

# Interactive user (not SYSTEM). Capture after elevation: UAC keeps the same account.
$InstallUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if (-not $InstallUser) {
    if ($env:USERDOMAIN) { $InstallUser = "$env:USERDOMAIN\$env:USERNAME" }
    else { $InstallUser = $env:USERNAME }
}

if (-not $Bind) {
    try {
        $tsIp = (tailscale ip -4 2>$null | Select-Object -First 1)
        if ($tsIp) { $tsIp = ([string]$tsIp).Trim() }
        if ($tsIp -match '^100\.') { $Bind = $tsIp }
    } catch {}
}
if (-not $Bind) { $Bind = '127.0.0.1' }

if ($Bind -eq '0.0.0.0') {
    Write-Host "==> Bind: 0.0.0.0 (-Bind override) WARNING: every interface, plaintext, LAN-only use."
} elseif ($Bind -eq '127.0.0.1') {
    Write-Host "==> Bind: 127.0.0.1 (no Tailscale found; reach it through an SSH tunnel or set -Bind 0.0.0.0)"
} elseif ($Bind -match '^100\.') {
    Write-Host "==> Bind: $Bind (Tailscale interface; set -Bind 0.0.0.0 for every interface)"
} else {
    Write-Host "==> Bind: $Bind (-Bind override)"
}

Write-Host 'Computer viewer - high-performance stream (Windows)'
Write-Host "LAN / Tailscale only - H.264 agent on ${Bind}:$ListenPort as $InstallUser."
Write-Host ''

function Refresh-ProcessPath {
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    if ($machine -and $user) {
        $env:Path = "$machine;$user"
    } elseif ($machine) {
        $env:Path = $machine
    }
}

function Resolve-Python {
    Refresh-ProcessPath
    $candidates = @(
        (Join-Path ${env:ProgramFiles} 'Python312\python.exe'),
        (Join-Path ${env:ProgramFiles} 'Python313\python.exe'),
        (Join-Path ${env:ProgramFiles} 'Python311\python.exe'),
        (Join-Path $env:LocalAppData 'Programs\Python\Python312\python.exe'),
        (Join-Path $env:LocalAppData 'Programs\Python\Python313\python.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    foreach ($name in @('python', 'python3')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source -and ($cmd.Source -notmatch 'WindowsApps\\python')) {
            return $cmd.Source
        }
    }
    return $null
}

function Test-PythonWorks([string]$Exe) {
    if (-not $Exe) { return $false }
    try {
        & $Exe -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Resolve-Ffmpeg {
    Refresh-ProcessPath
    # Program Files and the machine-scope winget locations first. C:\ffmpeg is
    # last and only used when no standard user can change it: any account may
    # create folders in C:\, and the logon task runs this ffmpeg.
    $candidates = @(
        (Join-Path ${env:ProgramFiles} 'ffmpeg\bin\ffmpeg.exe'),
        (Join-Path ${env:ProgramFiles} 'Gyan\FFmpeg\bin\ffmpeg.exe'),
        (Join-Path ${env:ProgramFiles} 'WinGet\Links\ffmpeg.exe')
    )
    $wingetPackages = Join-Path ${env:ProgramFiles} 'WinGet\Packages'
    if (Test-Path -LiteralPath $wingetPackages) {
        $candidates += @(Get-ChildItem -LiteralPath $wingetPackages -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue } |
            Select-Object -ExpandProperty FullName)
    }
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { $candidates = @($cmd.Source) + $candidates }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    $rootFfmpeg = 'C:\ffmpeg\bin\ffmpeg.exe'
    if (Test-Path -LiteralPath $rootFfmpeg) {
        $unsafe = $false
        foreach ($p in @('C:\ffmpeg', 'C:\ffmpeg\bin', $rootFfmpeg)) {
            if ((Test-IsLink $p) -or (Test-WritableByNonAdmins $p)) { $unsafe = $true }
        }
        if (-not $unsafe) { return $rootFfmpeg }
        Write-Warning "Skipping $rootFfmpeg : a non-administrator can change it (C:\ffmpeg is writable by other accounts or not owned by Administrators)."
    }
    return $null
}

function New-HiperfToken {
    $bytes = New-Object byte[] 16
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-OrCreateToken {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    if (Test-Path -LiteralPath $TokenFile) {
        $existing = (Get-Content -LiteralPath $TokenFile -Raw -ErrorAction SilentlyContinue)
        if ($existing) {
            $existing = $existing.Trim()
            if ($existing -match '^[0-9a-fA-F]{32}$') {
                Write-Step "Reusing token stored in $TokenFile"
                return $existing.ToLowerInvariant()
            }
        }
    }
    $tok = New-HiperfToken
    Set-Content -LiteralPath $TokenFile -Value $tok -Encoding ASCII
    Write-Step "Generated token -> $TokenFile"
    return $tok
}

# --- ACL helpers (well-known SIDs: independent of the display language) -----
$SidAdministrators = 'S-1-5-32-544'
$SidSystem = 'S-1-5-18'
$SidTrustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$TrustedOwnerSids = @($SidAdministrators, $SidSystem, $SidTrustedInstaller)

function Test-IsLink([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return [bool]($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint))
}

function Test-TrustedOwner([string]$Path) {
    $owner = (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier])
    return ($owner -and ($TrustedOwnerSids -contains $owner.Value))
}

function Reset-ChildAcls([string]$Dir, [System.Security.Principal.SecurityIdentifier]$Owner) {
    # Every item below $Dir: owner $Owner, explicit entries removed, only what
    # it inherits. These trees are the installer's own and hold no links, so a
    # link found here was planted: it is removed (the link only, never its
    # target) instead of followed; Set-Acl on a link would change its target.
    foreach ($child in @(Get-ChildItem -LiteralPath $Dir -Force)) {
        if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            Write-Warning "Removing unexpected link $($child.FullName)"
            if ($child.PSIsContainer) { [System.IO.Directory]::Delete($child.FullName, $false) }
            else { [System.IO.File]::Delete($child.FullName) }
            continue
        }
        $childAcl = Get-Acl -LiteralPath $child.FullName
        foreach ($ace in @($childAcl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
            [void]$childAcl.RemoveAccessRuleSpecific($ace)
        }
        $childAcl.SetAccessRuleProtection($false, $false)
        $childAcl.SetOwner($Owner)
        Set-Acl -LiteralPath $child.FullName -AclObject $childAcl
        if ($child.PSIsContainer) { Reset-ChildAcls -Dir $child.FullName -Owner $Owner }
    }
}

function Set-ProtectedAcl {
    # Replaces the ACL on $Path: inheritance removed, owner Administrators,
    # Administrators and SYSTEM full control, plus each $Extra grant
    # (@{ Identity = 'DOMAIN\user'; Rights = 'ReadAndExecute'; Inherit = $true }).
    # -Recurse resets everything below to inherit only from it.
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [object[]]$Extra = @(),
        [switch]$Recurse
    )
    if (Test-IsLink $Path) { throw "$Path is a link; refusing to set its ACL." }
    $isDir = (Get-Item -LiteralPath $Path -Force).PSIsContainer
    if ($isDir) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
    else { $acl = New-Object System.Security.AccessControl.FileSecurity }
    $admins = New-Object System.Security.Principal.SecurityIdentifier($SidAdministrators)
    $system = New-Object System.Security.Principal.SecurityIdentifier($SidSystem)
    $acl.SetOwner($admins)
    $acl.SetAccessRuleProtection($true, $false)
    $grants = @(
        @{ Identity = $admins; Rights = 'FullControl'; Inherit = $true },
        @{ Identity = $system; Rights = 'FullControl'; Inherit = $true }
    ) + @($Extra)
    foreach ($g in $grants) {
        $flags = 'None'
        if ($isDir -and $g.Inherit) { $flags = 'ContainerInherit, ObjectInherit' }
        $identity = $g.Identity
        if ($identity -is [string]) { $identity = New-Object System.Security.Principal.NTAccount($identity) }
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $g.Rights, $flags, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    if ($Recurse -and $isDir) { Reset-ChildAcls -Dir $Path -Owner $admins }
}

function Test-WritableByNonAdmins([string]$Path) {
    # True when anyone other than Administrators, SYSTEM or TrustedInstaller
    # owns $Path or may write, delete or re-permission it.
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if (-not $owner -or -not ($TrustedOwnerSids -contains $owner.Value)) { return $true }
    # WriteData, AppendData, WriteExtendedAttributes, DeleteSubdirectoriesAndFiles,
    # WriteAttributes, Delete, ChangePermissions, TakeOwnership, GENERIC_ALL, GENERIC_WRITE.
    $writeMask = [long](0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000)
    foreach ($ace in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
        if ($ace.AccessControlType -ne 'Allow') { continue }
        if ($TrustedOwnerSids -contains $ace.IdentityReference.Value) { continue }
        if (([long]$ace.FileSystemRights -band $writeMask) -ne 0) { return $true }
    }
    return $false
}

function Protect-HiperfState {
    # The state folder: Administrators and SYSTEM, the install user may only
    # list it. The hiperf tree (agent + venv): the install user reads and runs
    # it, nothing more, so no other account can drop a .pth or swap a file the
    # logon task runs. Whoever created any of it before, it is re-owned by
    # Administrators and its inherited and explicit entries are replaced.
    Set-ProtectedAcl -Path $StateDir -Extra @(@{ Identity = $InstallUser; Rights = 'ReadAndExecute'; Inherit = $false })
    Set-ProtectedAcl -Path $HiperfDir -Recurse -Extra @(@{ Identity = $InstallUser; Rights = 'ReadAndExecute'; Inherit = $true })
}

# --- ffmpeg + Python --------------------------------------------------------

$ffmpeg = Resolve-Ffmpeg
if (-not $ffmpeg) {
    Write-Step 'ffmpeg not found; installing Gyan.FFmpeg via winget'
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw 'winget not found and ffmpeg is missing. Install Gyan.FFmpeg, then re-run.'
    }
    & winget install -e --id Gyan.FFmpeg --scope machine --silent --accept-package-agreements --accept-source-agreements
    Start-Sleep -Seconds 2
    $ffmpeg = Resolve-Ffmpeg
}
if (-not $ffmpeg) {
    throw 'ffmpeg not available after install. Open a new Admin PowerShell and re-run.'
}
Write-Step "Using ffmpeg: $ffmpeg"

$python = Resolve-Python
if (-not (Test-PythonWorks $python)) {
    Write-Step 'Python not found; installing Python.Python.3.12 via winget (machine scope)'
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw 'winget not found and Python is missing. Install Python 3.12 from python.org, then re-run.'
    }
    & winget install -e --id Python.Python.3.12 --scope machine --silent --accept-package-agreements --accept-source-agreements
    Start-Sleep -Seconds 2
    $python = Resolve-Python
}
if (-not (Test-PythonWorks $python)) {
    throw 'Python 3.10+ not available after install. Open a new Admin PowerShell and re-run, or install from python.org.'
}
Write-Step "Using Python: $python"

New-Item -ItemType Directory -Force -Path $HiperfDir | Out-Null
# Locked down before the venv, the agent and the token are written into it.
Protect-HiperfState
$token = Get-OrCreateToken

$venvPython = Join-Path $VenvDir 'Scripts\python.exe'
$venvPythonw = Join-Path $VenvDir 'Scripts\pythonw.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Step "Creating dedicated venv at $VenvDir"
    & $python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "python -m venv failed (exit $LASTEXITCODE)." }
} else {
    Write-Step "Reusing venv at $VenvDir"
}
if (-not (Test-Path -LiteralPath $venvPython)) {
    throw "venv python missing at $venvPython"
}

Write-Step "Installing $WebsocketsPin into the venv"
& $venvPython -m pip install --upgrade pip | Out-Null
& $venvPython -m pip install $WebsocketsPin
if ($LASTEXITCODE -ne 0) {
    throw "pip install $WebsocketsPin failed (exit $LASTEXITCODE)."
}

function Get-ManifestAgentSha {
    # MANIFEST.sha256 sits at the repo root, one level above $RawRepoUrl.
    param([string]$Root, [string]$Here)
    $lines = $null
    try {
        $ProgressPreference = 'SilentlyContinue'
        $resp = Invoke-WebRequest -Uri "$Root/MANIFEST.sha256" -UseBasicParsing
        $lines = $resp.Content -split "`n"
    } catch {
        Write-Warning "Could not fetch $Root/MANIFEST.sha256: $_"
    }
    if (-not $lines -and $Here) {
        # Offline fallback. Two layouts: a clone keeps MANIFEST.sha256 one
        # level up (repo root, next to computer-viewer/), and install.sh puts a
        # copy two levels up (desktop-plugins/, next to computer-viewer/).
        $parent = Split-Path -Parent $Here
        $localManifests = @()
        if ($parent) {
            $localManifests += (Join-Path $parent 'MANIFEST.sha256')
            $grandparent = Split-Path -Parent $parent
            if ($grandparent) {
                $localManifests += (Join-Path $grandparent 'MANIFEST.sha256')
            }
        }
        foreach ($localManifest in $localManifests) {
            if (Test-Path -LiteralPath $localManifest) {
                $lines = Get-Content -LiteralPath $localManifest
                break
            }
        }
    }
    if (-not $lines) { return $null }
    foreach ($line in $lines) {
        $parts = ($line -replace "`r", '').Trim() -split '\s+', 2
        if ($parts.Count -eq 2 -and $parts[1].Trim() -eq 'computer-viewer/hiperf-agent.py') {
            return $parts[0]
        }
    }
    return $null
}

Write-Step 'Fetching hiperf-agent.py'
# Staged to a temp file and checked against MANIFEST.sha256 before it replaces
# anything, so a tampered or truncated download cannot become the running agent.
$here = $PSScriptRoot
if (-not $here -and $PSCommandPath) { $here = Split-Path -Parent $PSCommandPath }
$manifestRoot = $RawRepoUrl -replace '/computer-viewer$', ''
$agentSha = Get-ManifestAgentSha -Root $manifestRoot -Here $here
if (-not $agentSha) {
    throw "Could not read the hiperf-agent.py digest from $manifestRoot/MANIFEST.sha256 and no local MANIFEST.sha256 was found. Refusing to install an unverified agent."
}

$agentTmp = "$AgentPath.new"
if (Test-Path -LiteralPath $agentTmp) { Remove-Item -LiteralPath $agentTmp -Force }
$agentSrc = $null
try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri "$RawRepoUrl/hiperf-agent.py" -OutFile $agentTmp -UseBasicParsing
    $agentSrc = "$RawRepoUrl/hiperf-agent.py"
} catch {
    Write-Warning "Download failed: $_"
}
if (-not $agentSrc) {
    $local = $null
    if ($here) { $local = Join-Path $here 'hiperf-agent.py' }
    if ($local -and (Test-Path -LiteralPath $local)) {
        Copy-Item -LiteralPath $local -Destination $agentTmp -Force
        $agentSrc = "$local (download failed)"
    } else {
        throw "Could not download hiperf-agent.py from $RawRepoUrl and no local copy was found."
    }
}
$actualSha = (Get-FileHash -LiteralPath $agentTmp -Algorithm SHA256).Hash
if ($actualSha -ne $agentSha.ToUpperInvariant()) {
    Remove-Item -LiteralPath $agentTmp -Force -ErrorAction SilentlyContinue
    throw "hiperf-agent.py sha256 mismatch - refusing to install. manifest $agentSha, file $actualSha. Left $AgentPath untouched."
}
Move-Item -LiteralPath $agentTmp -Destination $AgentPath -Force
Write-Host "    installed from $agentSrc"
Write-Host "    sha256 $actualSha verified against MANIFEST.sha256"

if (-not (Test-Path -LiteralPath $LogFile)) {
    Set-Content -LiteralPath $LogFile -Value '' -Encoding ASCII
}

# Protected ACLs (inheritance removed): the agent tree and venv read+execute
# for the install user; the token readable only by the install user,
# Administrators and SYSTEM; the log (the agent's only runtime write, next to
# the token) modifiable by the install user.
Protect-HiperfState
Set-ProtectedAcl -Path $TokenFile -Extra @(@{ Identity = $InstallUser; Rights = 'Read'; Inherit = $false })
Set-ProtectedAcl -Path $LogFile -Extra @(@{ Identity = $InstallUser; Rights = 'Modify'; Inherit = $false })

# --- Scheduled Task (interactive user, AtLogOn, no 72h kill) ----------------

if (-not (Test-Path -LiteralPath $venvPythonw)) {
    throw "pythonw.exe missing at $venvPythonw"
}

Write-Step "Registering scheduled task $TaskName (user=$InstallUser, LogonType=Interactive, AtLogOn, ExecutionTimeLimit=0)"
# Default ExecutionTimeLimit is 72 hours - the task would be killed. Zero = unlimited.
# SYSTEM cannot capture the interactive desktop; this task MUST run as the installing user.
$arg = '"{0}" --port {1} --token-file "{2}" --ffmpeg "{3}" --bind {4}' -f $AgentPath, $ListenPort, $TokenFile, $ffmpeg, $Bind
$action = New-ScheduledTaskAction -Execute $venvPythonw -Argument $arg
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $InstallUser
$principal = New-ScheduledTaskPrincipal -UserId $InstallUser -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

try {
    Start-ScheduledTask -TaskName $TaskName
    Write-Step "Started $TaskName"
} catch {
    Write-Warning "Start-ScheduledTask failed: $_. The task will run at next logon."
}

# --- Firewall: stream port, Private profile ---------------------------------

Write-Step "Firewall: allow TCP $ListenPort on Private profile (not Public)"
try {
    $existing = Get-NetFirewallRule -DisplayName $FirewallName -ErrorAction SilentlyContinue
    if (-not $existing) {
        New-NetFirewallRule -DisplayName $FirewallName `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort $ListenPort `
            -Profile Private `
            -Description 'Computer viewer hiperf H.264 agent. LAN/Tailscale only.' | Out-Null
    } else {
        Write-Host "    Rule already exists: $FirewallName"
    }
} catch {
    Write-Warning "Could not add firewall rule: $_. Allow TCP $ListenPort inbound on the Private profile manually."
}

# --- Summary ----------------------------------------------------------------

$hostname = $env:COMPUTERNAME
if (-not $hostname) {
    $hostname = [System.Net.Dns]::GetHostName()
}

$tsIp = $null
$tsDns = $null
try {
    $tsIp = (tailscale ip -4 2>$null | Select-Object -First 1)
} catch {}
try {
    $json = tailscale status --json 2>$null | Out-String
    if ($json) {
        $obj = $json | ConvertFrom-Json
        if ($obj.Self -and $obj.Self.DNSName) {
            $tsDns = ([string]$obj.Self.DNSName).TrimEnd('.')
        }
    }
} catch {}

Write-Host ''
Write-Host '===================================================================='
Write-Host 'High-performance stream is installed. In the Computer plugin:'
Write-Host '  1. Open the computer endpoint (Advanced -> High-performance stream)'
Write-Host '  2. Paste the token below'
Write-Host '  3. Turn on HD (or click the HD button in the pane header)'
Write-Host ''
Write-Host 'Token:'
Write-Host "  $token"
Write-Host "  stored at $TokenFile"
Write-Host ''
Write-Host 'Optional stream URL override (leave blank to derive :6090 from the VNC host):'
if ($Bind -eq '127.0.0.1') {
    Write-Host '  Reach it through an SSH tunnel:'
    Write-Host ("    ssh -N -L {0}:127.0.0.1:{0} {1}@{2}" -f $ListenPort, $env:USERNAME, $hostname)
    Write-Host '  then paste:'
    Write-Host "    ws://127.0.0.1:${ListenPort}/stream"
} elseif ($Bind -eq '0.0.0.0') {
    Write-Host "  ws://${hostname}:${ListenPort}/stream"
    if ($tsDns) {
        Write-Host "  ws://${tsDns}:${ListenPort}/stream"
    }
    if ($tsIp) {
        Write-Host "  ws://${tsIp}:${ListenPort}/stream"
    }
    Write-Host '  WARNING: bound to every interface, plaintext. LAN-only use.'
} else {
    Write-Host "  ws://${Bind}:${ListenPort}/stream"
    if ($tsDns) {
        Write-Host "  ws://${tsDns}:${ListenPort}/stream"
    } else {
        Write-Host "  ws://<tailscale-name>:${ListenPort}/stream"
    }
}
Write-Host ''
Write-Host 'Notes:'
Write-Host '  - Run in Administrator PowerShell (this script self-elevates).'
Write-Host "  - HD agent is bound to ${Bind}:$ListenPort."
Write-Host '  - LAN / Tailscale only. Do not port-forward 6090.'
Write-Host '  - Task ComputerViewerHiperf runs as the interactive user, not SYSTEM.'
Write-Host "  - pythonw is silent; logs: $LogFile"
Write-Host '  - Tailscale adapters often register as Public. If the stream is'
Write-Host '    unreachable over Tailscale, also allow 6090 on Public:'
Write-Host ('      New-NetFirewallRule -DisplayName "Computer Viewer hiperf (6090 Public)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort {0} -Profile Public' -f $ListenPort)
Write-Host '===================================================================='
