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
$RawRepoUrl = 'https://raw.githubusercontent.com/thomasbek3/hermes-bot-kit/v2026.11.24/computer-viewer'
$StateDir = Join-Path $env:ProgramData 'hermes-cv'
$HiperfDir = Join-Path $StateDir 'hiperf'
$VenvDir = Join-Path $HiperfDir 'venv'
$AgentPath = Join-Path $HiperfDir 'hiperf-agent.py'
$TokenFile = Join-Path $StateDir 'hiperf-token.txt'
$RotationMarker = Join-Path $StateDir 'hiperf-rotation-pending'
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
$InstallUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

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
    # Only an all-users install whose file, folders and import locations are
    # admin-only is returned, validated before it is ever run as
    # Administrator (and before the venv the logon task uses is built on it).
    Refresh-ProcessPath
    $candidates = @(
        (Join-Path ${env:ProgramFiles} 'Python312\python.exe'),
        (Join-Path ${env:ProgramFiles} 'Python313\python.exe'),
        (Join-Path ${env:ProgramFiles} 'Python311\python.exe')
    )
    foreach ($name in @('python', 'python3')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source -and ($cmd.Source -notmatch 'WindowsApps\\python')) { $candidates += $cmd.Source }
    }
    foreach ($c in $candidates) {
        if (-not $c -or -not (Test-Path -LiteralPath $c -PathType Leaf)) { continue }
        if ($c -match '\\Users\\') { Write-Warning "Skipping per-user Python $c (its owner can change it)."; continue }
        if (Test-TrustedExecutable $c (Get-PythonImportDirs $c)) { return $c }
    }
    return $null
}

function Test-PythonWorks([string]$Exe) {
    # -I: isolated mode, no PYTHON* variables, user site-packages or current folder.
    if (-not $Exe) { return $false }
    try {
        & $Exe -I -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Resolve-Ffmpeg {
    Refresh-ProcessPath
    # Program Files, the machine-scope winget locations, PATH, then C:\ffmpeg.
    # The logon task runs this ffmpeg, so each candidate, and every folder
    # above it, must be admin-only (any account may create folders in C:\,
    # and PATH can name a user folder). A link (winget's Links) is followed
    # and its target checked the same way.
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
    if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }
    $candidates += 'C:\ffmpeg\bin\ffmpeg.exe'
    foreach ($c in $candidates) {
        if (-not $c -or -not (Test-Path -LiteralPath $c -PathType Leaf)) { continue }
        $real = $c
        if (Test-IsLink $c) {
            # The link's own folder must be admin-only too, or it could be re-pointed.
            if (-not (Test-ProtectedPath (Split-Path -Parent $c))) { Write-Warning "Skipping $c : its folder can be changed by a non-administrator."; continue }
            $target = @((Get-Item -LiteralPath $c -Force).Target)[0]
            if (-not $target) { continue }
            if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $c) $target }
            $real = [System.IO.Path]::GetFullPath($target)
        }
        if (Test-TrustedExecutable $real) { return $real }
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

function Get-PasswordAction([bool]$Exists, [bool]$OwnerOk, [bool]$WasReadableByOthers, [bool]$ContentOk) {
    # (Copied from connect-windows.ps1; there is no shared module.) 'reuse'
    # only for a stored secret nobody else could have read or set: the file
    # exists, it is ours (no link), its ACL as found gave nobody else read,
    # write or re-permission rights, and its content is valid. Else 'rotate'.
    if ($Exists -and $OwnerOk -and -not $WasReadableByOthers -and $ContentOk) { return 'reuse' }
    return 'rotate'
}

function Test-TokenAclExposed([object[]]$Rules, [string]$ReadOnlySid) {
    # Pure: true when an Allow rule that applies to the file lets anyone
    # other than Administrators, SYSTEM or TrustedInstaller read or change it,
    # except $ReadOnlySid (the install user), who may read but nothing more.
    $readMask = [long](0x1 -bor 0x10000000 -bor 0x80000000)
    $writeMask = [long](0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000)
    foreach ($ace in @($Rules)) {
        if (-not $ace -or $ace.AccessControlType -ne 'Allow') { continue }
        if (($ace.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        $sid = $ace.IdentityReference.Value
        if ($TrustedOwnerSids -contains $sid) { continue }
        $rights = [long]$ace.FileSystemRights
        if (($rights -band $writeMask) -ne 0) { return $true }
        if (($sid -ne $ReadOnlySid) -and (($rights -band $readMask) -ne 0)) { return $true }
    }
    return $false
}

function Get-TokenState {
    # Recorded BEFORE any ACL in the state tree is tightened (the token's
    # ACL includes what it inherits from the state folder, which
    # Protect-HiperfState replaces): was the existing token ours, and could
    # anyone else read or change it?
    $s = @{ Exists = $false; OwnerOk = $false; Exposed = $false }
    if (-not (Get-Item -LiteralPath $TokenFile -Force -ErrorAction SilentlyContinue)) { return $s }
    $s.Exists = $true
    $s.OwnerOk = (-not (Test-IsLink $TokenFile)) -and (Test-OwnedByUsOrTrusted $TokenFile)
    if ($s.OwnerOk) {
        $rules = (Get-Acl -LiteralPath $TokenFile).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
        $s.Exposed = Test-TokenAclExposed @($rules) $InstallUserSid
    }
    return $s
}

function Get-OrCreateToken($State) {
    # $State: Get-TokenState, taken before the tree was re-permissioned. A
    # token another account owns, a link, or one others could read or change
    # may be known: a new one is made (rotation) and printed. Returns
    # @{ Token; New }. A new token is written later by Invoke-TokenRotation,
    # after the running agent is stopped; the old file is deleted now, so an
    # install that fails before then makes a new token next time.
    $existing = ''
    if ($State.Exists -and $State.OwnerOk -and -not $State.Exposed) {
        $existing = ([string](Get-Content -LiteralPath $TokenFile -Raw -ErrorAction SilentlyContinue)).Trim()
    }
    $action = Get-PasswordAction -Exists $State.Exists -OwnerOk $State.OwnerOk -WasReadableByOthers $State.Exposed -ContentOk ($existing -match '^[0-9a-fA-F]{32}$')
    if ($action -eq 'reuse') {
        Write-Step "Reusing token stored in $TokenFile"
        return @{ Token = $existing.ToLowerInvariant(); New = $false }
    }
    if ($State.Exists) {
        $why = 'it was not created by this installer (or is a link)'
        if ($State.OwnerOk -and $State.Exposed) { $why = 'accounts other than the install user and administrators could read or change it, so the old token may be known' }
        elseif ($State.OwnerOk) { $why = 'it does not hold a valid token' }
        Write-Warning "Not reusing ${TokenFile}: $why. Rotating to a new HD token; paste the one printed below into the viewer."
    }
    Remove-TreeNoFollow $TokenFile
    return @{ Token = (New-HiperfToken); New = $true }
}

function Write-HiperfToken([string]$Token) {
    # A new file, locked down before the token is written into it (links removed as links).
    Remove-TreeNoFollow $TokenFile
    New-Item -ItemType File -Path $TokenFile -ErrorAction Stop | Out-Null
    Set-ProtectedAcl -Path $TokenFile -Extra @(@{ Identity = $InstallUser; Rights = 'Read'; Inherit = $false })
    Set-Content -LiteralPath $TokenFile -Value $Token -Encoding ASCII
    Write-Step "Generated token -> $TokenFile"
}

function Select-KitHiperf([object[]]$Processes, [string]$PythonwExe, [string]$AgentPath) {
    # Pure: the Win32_Process entries that are this kit's HD agent: the
    # venv's pythonw.exe with $AgentPath on its command line, and the
    # interpreter it starts: a venv's Scripts\pythonw.exe is a launcher that
    # runs the base pythonw as its child (same command line), and that child
    # is the one listening. Any other python is never selected.
    $hasAgent = { ([string]$args[0].CommandLine).IndexOf($AgentPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
    $kit = @(@($Processes) | Where-Object { $_ -and ([string]$_.ExecutablePath -ieq $PythonwExe) -and (& $hasAgent $_) })
    $kitIds = @($kit | ForEach-Object { $_.ProcessId })
    $kit + @(@($Processes) | Where-Object { $_ -and ($kitIds -contains $_.ParentProcessId) -and ($kitIds -notcontains $_.ProcessId) -and (& $hasAgent $_) })
}

function Stop-KitHiperf {
    # Stops the kit's task, then confirms no kit agent process is left
    # (a leftover one, and only that one, is killed and checked again).
    # Throws when it cannot be confirmed gone.
    Stop-ScheduledTask -TaskName $TaskName
    foreach ($round in 1..2) {
        $left = @(Select-KitHiperf -Processes @(Get-CimInstance -ClassName Win32_Process -Filter "Name='pythonw.exe'" -ErrorAction Stop) -PythonwExe $venvPythonw -AgentPath $AgentPath)
        if ($left.Count -eq 0) { return }
        if ($round -eq 2) { throw "The HD agent ($venvPythonw $AgentPath, PID $(($left | ForEach-Object { $_.ProcessId }) -join ', ')) is still running after it was stopped. The new token was not written; end that process, then re-run." }
        # The re-check above, not this call's result, decides.
        foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 2
    }
}

function Start-KitHiperf {
    Start-ScheduledTask -TaskName $TaskName
    Write-Step "Started $TaskName"
}

function Get-RotationAction([bool]$NewToken, [bool]$MarkerPresent) {
    # Pure: 'rotate' for a new token, or when an earlier rotation never got
    # its confirmation (the marker is still there), even if the stored token
    # looks fine now. Else 'none'.
    if ($NewToken -or $MarkerPresent) { return 'rotate' }
    return 'none'
}

function Write-RotationMarker {
    # An empty admin-only file: "a rotation started and is not confirmed".
    Remove-TreeNoFollow $RotationMarker
    New-Item -ItemType File -Path $RotationMarker -ErrorAction Stop | Out-Null
    Set-ProtectedAcl -Path $RotationMarker
}

function Wait-KitHiperfListening([int]$TimeoutSec = 60) {
    # After a start: waits (the agent dry-runs ffmpeg before it listens)
    # until the kit's own agent (the venv pythonw running $AgentPath) is up
    # AND is the process listening on $ListenPort. A port held by any other
    # process throws, naming it. Nothing connects to the agent.
    $kitPids = @()
    foreach ($round in 1..([Math]::Max(1, [int]($TimeoutSec / 2)))) {
        $kitPids = @(Select-KitHiperf -Processes @(Get-CimInstance -ClassName Win32_Process -Filter "Name='pythonw.exe'" -ErrorAction Stop) -PythonwExe $venvPythonw -AgentPath $AgentPath | ForEach-Object { [int]$_.ProcessId })
        $owners = @(Get-NetTCPConnection -State Listen -LocalPort $ListenPort -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
        foreach ($o in $owners) {
            if ($kitPids -notcontains $o) {
                $path = [string](@(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$o" -ErrorAction SilentlyContinue) | Select-Object -First 1).ExecutablePath
                if (-not $path) { $path = '(unknown path)' }
                throw "Port $ListenPort is held by $path (PID $o), not the HD agent. End that process, then re-run."
            }
        }
        if ($owners.Count -gt 0) { return }
        Start-Sleep -Seconds 2
    }
    if ($kitPids.Count -eq 0) { throw "The HD agent ($venvPythonw $AgentPath) did not start. See $LogFile, start $TaskName from Task Scheduler, then re-run." }
    throw "The HD agent (PID $($kitPids -join ', ')) is not listening on port $ListenPort after $TimeoutSec s. See $LogFile, then re-run."
}

function Invoke-TokenRotation([bool]$Rotate, [string]$Token) {
    # The running agent holds the token it read at start, so: mark the
    # rotation pending, stop the agent and confirm it is gone, write the
    # token, start it, and confirm the kit's own agent owns the port. The
    # token is never sent anywhere. The marker goes only once that is
    # confirmed, so a failed run rotates again next time. Returns $false
    # (and does nothing) when there is nothing to rotate.
    if (-not $Rotate) { return $false }
    Write-RotationMarker
    Stop-KitHiperf
    Write-HiperfToken $Token
    Start-KitHiperf
    Wait-KitHiperfListening
    Remove-TreeNoFollow $RotationMarker
    Write-Step 'The new HD token is in place. Reconnect the HD viewer with the token below to confirm.'
    return $true
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
        # An inherit-only entry (e.g. CREATOR OWNER on Program Files) does not apply to this object.
        if (($ace.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($TrustedOwnerSids -contains $ace.IdentityReference.Value) { continue }
        if (([long]$ace.FileSystemRights -band $writeMask) -ne 0) { return $true }
    }
    return $false
}

function Test-ProtectedPath([string]$Path) {
    # Exists, is not a link, and only Administrators/SYSTEM/TrustedInstaller
    # own it or may write, delete or re-permission it.
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if (Test-IsLink $Path) { return $false }
    return -not (Test-WritableByNonAdmins $Path)
}

function Test-TrustedExecutable([string]$Exe, [string[]]$ImportDirs = @()) {
    # The file, every folder above it up to (not including) the drive root,
    # and each folder it loads code from must be admin-only. Checked BEFORE
    # the first time it is run.
    if (-not $Exe -or -not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $false }
    $paths = @($Exe)
    $dir = Split-Path -Parent $Exe
    while ($dir -and (Split-Path -Parent $dir)) {
        $paths += $dir
        $dir = Split-Path -Parent $dir
    }
    foreach ($d in $ImportDirs) { if (Test-Path -LiteralPath $d) { $paths += $d } }
    foreach ($p in $paths) {
        if (-not (Test-ProtectedPath $p)) {
            Write-Warning "$p can be changed by a non-administrator (or is a link); not using $Exe."
            return $false
        }
    }
    return $true
}

function Get-PythonImportDirs([string]$Exe) {
    $dir = Split-Path -Parent $Exe
    return @((Join-Path $dir 'Lib'), (Join-Path $dir 'Lib\site-packages'), (Join-Path $dir 'DLLs'))
}

function Find-UntrustedItem([string]$Root, [switch]$Writable) {
    # The first item at or below $Root that is a link or is owned by an
    # account other than Administrators/SYSTEM/TrustedInstaller/this one.
    # -Writable: also one whose ACL lets a non-administrator write, delete or
    # re-permission it (ACLs, not just the owner). Links are reported, never
    # followed.
    $item = Get-Item -LiteralPath $Root -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $null }
    if ((Test-IsLink $Root) -or -not (Test-OwnedByUsOrTrusted $Root)) { return $Root }
    if ($Writable -and (Test-WritableByNonAdmins $Root)) { return $Root }
    if (-not $item.PSIsContainer) { return $null }
    foreach ($child in @(Get-ChildItem -LiteralPath $Root -Force)) {
        $bad = Find-UntrustedItem $child.FullName -Writable:$Writable
        if ($bad) { return $bad }
    }
    return $null
}

function Remove-TreeNoFollow([string]$Path) {
    # Deletes $Path and everything below it without following a link: a
    # junction or symlink is removed as a link, its target untouched; real
    # folders are recursed into. Never Remove-Item -Recurse on such a tree:
    # Windows PowerShell 5.1 can follow a junction.
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return }
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        if ($item.PSIsContainer) { [System.IO.Directory]::Delete($item.FullName, $false) }
        else { [System.IO.File]::Delete($item.FullName) }
        return
    }
    if ($item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) { Remove-TreeNoFollow $child.FullName }
        [System.IO.Directory]::Delete($item.FullName, $false)
        return
    }
    if ($item.Attributes -band [System.IO.FileAttributes]::ReadOnly) {
        $item.Attributes = $item.Attributes -bxor [System.IO.FileAttributes]::ReadOnly
    }
    [System.IO.File]::Delete($item.FullName)
}

function Get-VenvAction([string]$CfgText, [string]$ExpectedHome, [bool]$TreeOk, [bool]$ExesPresent) {
    # 'reuse' only for a venv built on the validated Python: pyvenv.cfg has
    # exactly one home = line naming that Python's folder (full path, any
    # case), nothing in the HD tree could be changed by a non-administrator,
    # and both launchers exist. Anything else: 'rebuild'.
    if (-not $TreeOk -or -not $ExesPresent -or -not $CfgText -or -not $ExpectedHome) { return 'rebuild' }
    $homes = @([regex]::Matches($CfgText, '(?im)^[ \t]*home[ \t]*=(.*)$') | ForEach-Object { $_.Groups[1].Value.Trim() })
    if ($homes.Count -ne 1 -or -not $homes[0]) { return 'rebuild' }
    try {
        $have = [System.IO.Path]::GetFullPath($homes[0]).TrimEnd('\', '/')
        $want = [System.IO.Path]::GetFullPath($ExpectedHome.Trim()).TrimEnd('\', '/')
    } catch {
        return 'rebuild'
    }
    if ([string]::Equals($have, $want, [System.StringComparison]::OrdinalIgnoreCase)) { return 'reuse' }
    return 'rebuild'
}

function Test-VenvTrusted([string]$Dir, [string]$Python, [bool]$TreeOk) {
    # $TreeOk: the HD tree as found, recorded before Protect-HiperfState
    # re-permissioned it. The venv is also checked again as it is now.
    if ($TreeOk -and (Find-UntrustedItem $Dir -Writable)) { $TreeOk = $false }
    $cfg = Join-Path $Dir 'pyvenv.cfg'
    $text = ''
    if (Test-Path -LiteralPath $cfg -PathType Leaf) { $text = [string](Get-Content -LiteralPath $cfg -Raw) }
    $exes = (Test-Path -LiteralPath (Join-Path $Dir 'Scripts\python.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Dir 'Scripts\pythonw.exe') -PathType Leaf)
    return ((Get-VenvAction -CfgText $text -ExpectedHome (Split-Path -Parent $Python) -TreeOk $TreeOk -ExesPresent $exes) -eq 'reuse')
}

function Assert-TrustedTree([string]$Root) {
    $bad = Find-UntrustedItem $Root
    if ($bad) {
        $owner = (Get-Acl -LiteralPath $bad).Owner
        throw "$bad (under $Root) was not created by an administrator (owner '$owner', or it is a link). Another account may have put it there. Check it, delete $Root from an Administrator prompt (cmd /c rmdir /s /q `"$Root`", which does not follow links), then re-run."
    }
}

function New-TrustedDir([string]$Path) {
    # Exclusive create: a folder that appears in between is not adopted.
    if (Test-Path -LiteralPath $Path) { Assert-TrustedTree $Path; return }
    New-Item -ItemType Directory -Path $Path -ErrorAction Stop | Out-Null
}

function Test-OwnedByUsOrTrusted([string]$Path) {
    # True when $Path is owned by Administrators, SYSTEM, TrustedInstaller or
    # the account running this installer (not by some other local account
    # that could have created it first under C:\ProgramData).
    $owner = (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier])
    if (-not $owner) { return $false }
    if ($TrustedOwnerSids -contains $owner.Value) { return $true }
    return ($owner.Value -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
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

# A state tree another account created or put anything into (a standard user
# may create folders in C:\ProgramData) is refused, not adopted: re-owning it
# would keep whatever was planted. Checked before anything is re-owned.
$hiperfTreeOk = $true
if (Test-Path -LiteralPath $StateDir) {
    if ((Test-IsLink $StateDir) -or -not (Test-OwnedByUsOrTrusted $StateDir)) { Assert-TrustedTree $StateDir }
    # A token another account owns (or a link) stops the install here, as
    # before; Get-OrCreateToken would rotate it anyway, never reuse it.
    foreach ($p in @($HiperfDir, $TokenFile, $LogFile)) { Assert-TrustedTree $p }
    # ACLs, not just owners, recorded BEFORE Protect-HiperfState re-permissions
    # the tree: an item a non-administrator could write may have been changed,
    # so the venv is rebuilt (the agent is replaced by the verified download).
    $changeable = Find-UntrustedItem $HiperfDir -Writable
    if ($changeable) {
        $hiperfTreeOk = $false
        Write-Warning "$changeable could be changed by a non-administrator; the HD venv will be rebuilt."
    }
}
# The token's ORIGINAL ACL, recorded before Protect-HiperfState or the token's
# own Set-ProtectedAcl tightens anything: an exposed token is rotated.
$tokenState = Get-TokenState
New-TrustedDir $StateDir
New-TrustedDir $HiperfDir
# Locked down before the venv, the agent and the token are written into it.
Protect-HiperfState
$tokenInfo = Get-OrCreateToken $tokenState
$token = $tokenInfo.Token

$venvPython = Join-Path $VenvDir 'Scripts\python.exe'
$venvPythonw = Join-Path $VenvDir 'Scripts\pythonw.exe'
# The venv's python runs only when the venv was built on $python and nobody
# else could have changed it; otherwise it is deleted (links as links) and
# built again, inside the now admin-only tree.
if (Test-VenvTrusted -Dir $VenvDir -Python $python -TreeOk $hiperfTreeOk) {
    Write-Step "Reusing venv at $VenvDir"
} else {
    if (Get-Item -LiteralPath $VenvDir -Force -ErrorAction SilentlyContinue) {
        Write-Step "Rebuilding the venv at $VenvDir (not built on $python, incomplete, or changeable by others)"
        Remove-TreeNoFollow $VenvDir
    }
    Write-Step "Creating dedicated venv at $VenvDir"
    & $python -I -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "python -m venv failed (exit $LASTEXITCODE)." }
}
if (-not (Test-Path -LiteralPath $venvPython)) {
    throw "venv python missing at $venvPython"
}

Write-Step "Installing $WebsocketsPin into the venv"
& $venvPython -I -m pip install $WebsocketsPin
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
# Revalidated right before the agent is placed.
Assert-TrustedTree $HiperfDir
if (-not (Test-ProtectedPath $HiperfDir)) {
    Remove-Item -LiteralPath $agentTmp -Force -ErrorAction SilentlyContinue
    throw "$HiperfDir is no longer admin-only; refusing to place the agent. Re-run the installer."
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
# A new token is written (locked) by Invoke-TokenRotation below.
if (-not $tokenInfo.New) { Set-ProtectedAcl -Path $TokenFile -Extra @(@{ Identity = $InstallUser; Rights = 'Read'; Inherit = $false }) }
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

# A new token, or an earlier rotation left unconfirmed: stop the running
# agent, write the token, start, and confirm the kit's agent owns the port
# (throws otherwise, before the token is printed below).
$markerPresent = [bool](Get-Item -LiteralPath $RotationMarker -Force -ErrorAction SilentlyContinue)
$rotate = (Get-RotationAction -NewToken $tokenInfo.New -MarkerPresent $markerPresent) -eq 'rotate'
if (-not (Invoke-TokenRotation -Rotate $rotate -Token $token)) {
    try {
        Start-KitHiperf
    } catch {
        Write-Warning "Start-ScheduledTask failed: $_. The task will run at next logon."
    }
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
