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

$ErrorActionPreference = 'Stop'
$ListenPort = 6090
$TaskName = 'ComputerViewerHiperf'
$FirewallName = 'Computer Viewer hiperf (6090)'
$RawRepoUrl = 'https://raw.githubusercontent.com/thomasbek3/hermes-computer-viewer/master'
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
        $proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -PassThru -Wait -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $file
        )
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

Write-Host 'Computer viewer - high-performance stream (Windows)'
Write-Host "LAN / Tailscale only - H.264 agent on 0.0.0.0:$ListenPort as $InstallUser."
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
    $candidates = @(
        (Join-Path 'C:\ffmpeg\bin' 'ffmpeg.exe'),
        (Join-Path ${env:ProgramFiles} 'ffmpeg\bin\ffmpeg.exe'),
        (Join-Path ${env:ProgramFiles} 'Gyan\FFmpeg\bin\ffmpeg.exe')
    )
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { $candidates = @($cmd.Source) + $candidates }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
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

function Grant-UserAcl([string]$Path, [string]$User, [string]$Rights, [bool]$Inherit) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        $acl = Get-Acl -LiteralPath $Path
        if ($Inherit) {
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $User, $Rights, 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        } else {
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $User, $Rights, 'Allow')
        }
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $Path -AclObject $acl
    } catch {
        Write-Warning "Could not grant $Rights on $Path to $User : $_"
    }
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

Write-Step 'Fetching hiperf-agent.py'
$downloaded = $false
try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri "$RawRepoUrl/hiperf-agent.py" -OutFile $AgentPath -UseBasicParsing
    $downloaded = $true
    Write-Host "    downloaded from $RawRepoUrl/hiperf-agent.py"
} catch {
    Write-Warning "Download failed: $_"
}
if (-not $downloaded) {
    $here = $PSScriptRoot
    if (-not $here -and $PSCommandPath) { $here = Split-Path -Parent $PSCommandPath }
    $local = $null
    if ($here) { $local = Join-Path $here 'hiperf-agent.py' }
    if ($local -and (Test-Path -LiteralPath $local)) {
        Copy-Item -LiteralPath $local -Destination $AgentPath -Force
        Write-Host "    copied local $local (download failed)"
    } else {
        throw "Could not download hiperf-agent.py from $RawRepoUrl and no local copy was found."
    }
}

if (-not (Test-Path -LiteralPath $LogFile)) {
    Set-Content -LiteralPath $LogFile -Value '' -Encoding ASCII
}

# Token + venv must be readable by the interactive user (not only Admin/SYSTEM).
Grant-UserAcl -Path $HiperfDir -User $InstallUser -Rights 'ReadAndExecute' -Inherit $true
Grant-UserAcl -Path $TokenFile -User $InstallUser -Rights 'Read' -Inherit $false
Grant-UserAcl -Path $LogFile -User $InstallUser -Rights 'Modify' -Inherit $false
Grant-UserAcl -Path $StateDir -User $InstallUser -Rights 'Read' -Inherit $false

# --- Scheduled Task (interactive user, AtLogOn, no 72h kill) ----------------

if (-not (Test-Path -LiteralPath $venvPythonw)) {
    throw "pythonw.exe missing at $venvPythonw"
}

Write-Step "Registering scheduled task $TaskName (user=$InstallUser, LogonType=Interactive, AtLogOn, ExecutionTimeLimit=0)"
# Default ExecutionTimeLimit is 72 hours - the task would be killed. Zero = unlimited.
# SYSTEM cannot capture the interactive desktop; this task MUST run as the installing user.
$arg = '"{0}" --port {1} --token-file "{2}" --ffmpeg "{3}" --bind 0.0.0.0' -f $AgentPath, $ListenPort, $TokenFile, $ffmpeg
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
Write-Host "  ws://${hostname}:${ListenPort}/stream"
if ($tsDns) {
    Write-Host "  ws://${tsDns}:${ListenPort}/stream"
}
if ($tsIp) {
    Write-Host "  ws://${tsIp}:${ListenPort}/stream"
}
Write-Host ''
Write-Host 'Notes:'
Write-Host '  - Run in Administrator PowerShell (this script self-elevates).'
Write-Host '  - LAN / Tailscale only. Do not port-forward 6090.'
Write-Host '  - Task ComputerViewerHiperf runs as the interactive user, not SYSTEM.'
Write-Host "  - pythonw is silent; logs: $LogFile"
Write-Host '  - Tailscale adapters often register as Public. If the stream is'
Write-Host '    unreachable over Tailscale, also allow 6090 on Public:'
Write-Host ('      New-NetFirewallRule -DisplayName "Computer Viewer hiperf (6090 Public)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort {0} -Profile Public' -f $ListenPort)
Write-Host '===================================================================='
