#Requires -Version 5.1
<#
.SYNOPSIS
  Bridge this Windows desktop (TightVNC :5900, loopback-only) to a WebSocket
  the Computer plugin can paste: ws://<hostname>:6080/websockify

.NOTES
  Must run elevated (Administrator). Self-elevates via Start-Process -Verb RunAs.
  Idempotent. LAN / Tailscale only — VNC is loopback-only; only TCP 6080 is opened
  on the Private firewall profile.

  TightVNC MSI SET_PASSWORD / VALUE_OF_PASSWORD is historically unreliable
  (upstream bug #1392: 8-char passwords could be dropped; some 2.8.x builds omit
  the properties). We still pass them, print the generated password regardless,
  and may need a registry / TightVNC configuration fallback for auth.
#>

$ErrorActionPreference = 'Stop'
$ListenPort = 6080
$VncPort = 5900
$WebsockifyPin = 'websockify==0.13.0'
$TaskName = 'ComputerViewerWebsockify'
$FirewallName = 'Computer Viewer websockify (6080)'
$TightVncUrl = 'https://www.tightvnc.com/download/2.8.88/tightvnc-2.8.88-gpl-setup-64bit.msi'
$StateDir = Join-Path $env:ProgramData 'hermes-cv'
$PasswordFile = Join-Path $StateDir 'vnc-password.txt'

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
        $file = Join-Path $env:TEMP 'computer-viewer-connect-windows.ps1'
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

Write-Host 'Computer viewer — Windows TightVNC + websockify bridge'
Write-Host "LAN / Tailscale only — VNC stays on 127.0.0.1:$VncPort; websocket on 0.0.0.0:$ListenPort."
Write-Host ''

function New-VncPassword8 {
    # Classic VNC / TightVNC DES auth is 8 characters max.
    $alphabet = [char[]](65..90 + 97..122 + 48..57)
    $bytes = New-Object byte[] 8
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

function Get-OrCreateVncPassword {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    if (Test-Path -LiteralPath $PasswordFile) {
        $existing = (Get-Content -LiteralPath $PasswordFile -Raw -ErrorAction SilentlyContinue)
        if ($existing) {
            $existing = $existing.Trim()
            if ($existing.Length -ge 1) {
                Write-Step "Reusing VNC password stored in $PasswordFile"
                return $existing.Substring(0, [Math]::Min(8, $existing.Length))
            }
        }
    }
    $pw = New-VncPassword8
    Set-Content -LiteralPath $PasswordFile -Value $pw -Encoding ASCII
    try {
        $acl = Get-Acl -LiteralPath $PasswordFile
        $acl.SetAccessRuleProtection($true, $false)
        $admin = New-Object System.Security.AccessControl.FileSystemAccessRule(
            'BUILTIN\Administrators', 'FullControl', 'Allow')
        $system = New-Object System.Security.AccessControl.FileSystemAccessRule(
            'NT AUTHORITY\SYSTEM', 'FullControl', 'Allow')
        $acl.AddAccessRule($admin)
        $acl.AddAccessRule($system)
        Set-Acl -LiteralPath $PasswordFile -AclObject $acl
    } catch {
        # Best-effort ACL harden; the file still exists.
    }
    Write-Step "Generated 8-char VNC password (DES limit) → $PasswordFile"
    return $pw
}

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

$vncPassword = Get-OrCreateVncPassword

# --- TightVNC ---------------------------------------------------------------

$tvn = Join-Path ${env:ProgramFiles} 'TightVNC\tvnserver.exe'
$tvnInstalled = (Test-Path -LiteralPath $tvn) -or (Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue)

if (-not $tvnInstalled) {
    Write-Step "Downloading TightVNC 64-bit MSI from official tightvnc.com"
    $msi = Join-Path $env:TEMP 'tightvnc-2.8.88-gpl-setup-64bit.msi'
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $TightVncUrl -OutFile $msi -UseBasicParsing
    Write-Step 'Installing TightVNC Server (service, SAS/CAD, VNC auth)'
    # MSI password properties are unreliable — see header comment. Print $vncPassword later regardless.
    $msiArgs = @(
        '/i', $msi,
        '/quiet', '/norestart',
        'ADDLOCAL=Server',
        'SERVER_REGISTER_AS_SERVICE=1',
        'SERVER_ALLOW_SAS=1',
        'SET_USEVNCAUTHENTICATION=1',
        'VALUE_OF_USEVNCAUTHENTICATION=1',
        'SET_PASSWORD=1',
        "VALUE_OF_PASSWORD=$vncPassword"
    )
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru
    if ($p.ExitCode -notin 0, 3010) {
        Write-Warning "msiexec exited $($p.ExitCode). TightVNC may already be present; continuing."
    }
} else {
    Write-Step 'TightVNC Server already installed — skipping MSI'
}

Write-Step 'Hardening TightVNC to loopback-only (registry, best-effort)'
$regPaths = @(
    'HKLM:\SOFTWARE\TightVNC\Server',
    'HKLM:\SOFTWARE\WOW6432Node\TightVNC\Server'
)
foreach ($rp in $regPaths) {
    try {
        if (-not (Test-Path -LiteralPath $rp)) {
            New-Item -Path $rp -Force | Out-Null
        }
        New-ItemProperty -Path $rp -Name 'AllowLoopback' -PropertyType DWord -Value 1 -Force | Out-Null
        New-ItemProperty -Path $rp -Name 'LoopbackOnly' -PropertyType DWord -Value 1 -Force | Out-Null
        Write-Host "    Set AllowLoopback=1, LoopbackOnly=1 at $rp"
    } catch {
        Write-Warning "Could not write $rp : $_"
    }
}

try {
    $svc = Get-Service -Name 'tvnserver' -ErrorAction Stop
    if ($svc.Status -ne 'Running') {
        Start-Service -Name 'tvnserver'
    } else {
        Restart-Service -Name 'tvnserver' -Force
    }
    Write-Step 'Restarted service tvnserver'
} catch {
    Write-Warning "Could not start/restart tvnserver: $_. Start TightVNC Server (Service Mode) from the Start menu."
}

# --- Python + websockify ----------------------------------------------------

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
    throw "Python 3.10+ not available after install. Open a new Admin PowerShell and re-run, or install from python.org."
}

Write-Step "Using Python: $python"
if ($python -match '\\Users\\') {
    Write-Warning "Python looks like a per-user install. The SYSTEM scheduled task may not see it. Prefer: winget install -e --id Python.Python.3.12 --scope machine"
}
Write-Step "Installing $WebsockifyPin (machine site-packages — SYSTEM scheduled task has no user PATH)"
& $python -m pip install --upgrade pip | Out-Null
& $python -m pip install $WebsockifyPin
if ($LASTEXITCODE -ne 0) {
    throw "pip install $WebsockifyPin failed (exit $LASTEXITCODE)."
}

# --- Scheduled Task (SYSTEM, at startup, no 72h kill) ----------------------

Write-Step "Registering scheduled task $TaskName (SYSTEM, AtStartup, ExecutionTimeLimit=0)"
# Default ExecutionTimeLimit is 72 hours — the task would be killed. Zero = unlimited.
$action = New-ScheduledTaskAction -Execute $python -Argument "-m websockify 0.0.0.0:$ListenPort 127.0.0.1:$VncPort"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
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
    Write-Warning "Start-ScheduledTask failed: $_. The task will run at next boot."
}

# --- Firewall: websocket only, Private profile ------------------------------

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
            -Description 'Computer viewer websockify. LAN/Tailscale only. VNC stays loopback.' | Out-Null
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

Write-Host ''
Write-Host '===================================================================='
Write-Host 'Paste this address in Computer:'
Write-Host "  ws://${hostname}:${ListenPort}/websockify"
Write-Host ''
Write-Host 'VNC password (paste into the plugin Password field):'
Write-Host "  $vncPassword"
Write-Host "Stored at $PasswordFile"
Write-Host ''
Write-Host 'Notes:'
Write-Host '  - Run in Administrator PowerShell (this script self-elevates).'
Write-Host '  - LAN / Tailscale only. Do not port-forward 5900 or 6080.'
Write-Host '  - TightVNC is loopback-only; only the websocket port is on the LAN.'
Write-Host '  - UAC prompts show only in TightVNC service mode — they will. That is expected.'
Write-Host '  - Defender may flag VNC. Allow TightVNC / tvnserver if it quarantines it.'
Write-Host '  - Tailscale names work too: ws://<tailscale-name>:6080/websockify'
Write-Host '  - .local / MagicDNS both work on a private net.'
Write-Host '===================================================================='
