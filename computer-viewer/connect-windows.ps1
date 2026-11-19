#Requires -Version 5.1
<#
.SYNOPSIS
  Bridge this Windows desktop (TightVNC :5900, loopback-only) to a WebSocket
  the Computer plugin can paste: ws://<hostname>:6080/websockify

.NOTES
  Must run elevated (Administrator). Self-elevates via Start-Process -Verb RunAs.
  Idempotent. LAN / Tailscale only - VNC is loopback-only; only TCP 6080 is opened
  on the Private firewall profile.

  TightVNC MSI SET_PASSWORD / VALUE_OF_PASSWORD is historically unreliable
  (upstream bug #1392: 8-char passwords could be dropped; some 2.8.x builds omit
  the properties), and a command line is visible to other accounts. So the
  password is never passed to msiexec: it is written to the server's registry
  value (the same DES form vncpasswd uses), read back, and the service is
  restarted, on every run, before the password is printed.

  Everything run as Administrator or SYSTEM (Python, websockify, the virtual
  display installer, UltraVNC) must sit in admin-only folders, checked before
  its first run; a folder another account created first is refused.

  Headless PCs (no monitor, VirtualScreen 1024x768 / WinDisc): install Amyuni
  usbmmidd_v2 (signed IDD, no test-signing) and persist enableidd at startup.
  TightVNC's DXGI grab of that IDD is black on Win11; switch capture to UltraVNC
  hook/poll on loopback :5900. Non-fatal if the driver signature is rejected -
  print the HDMI dummy-plug fallback. Machines with a real monitor are unchanged.
#>

param(
    [string]$Bind = ''
)

$ErrorActionPreference = 'Stop'
$ListenPort = 6080
$VncPort = 5900
$WebsockifyPin = 'websockify==0.13.0'
$TaskName = 'ComputerViewerWebsockify'
$FirewallName = 'Computer Viewer websockify (6080)'
$TightVncUrl = 'https://www.tightvnc.com/download/2.8.88/tightvnc-2.8.88-gpl-setup-64bit.msi'
$StateDir = Join-Path $env:ProgramData 'hermes-cv'
$PasswordFile = Join-Path $StateDir 'vnc-password.txt'
$UsbmmiddUrl = 'https://amyuni.com/downloads/usbmmidd_v2.zip'
$UsbmmiddDir = 'C:\usbmmidd_v2'
$UsbmmiddTaskName = 'ComputerViewerVirtualDisplay'
$UltraVncZipUrl = 'https://uvnc.eu/download/1800/UltraVNC_1824.zip'
$UltraVncDir = Join-Path ${env:ProgramFiles} 'UltraVNC'

# sha256 of the two version-pinned third-party downloads, computed 2026-09-07
# from the exact URLs above. These URLs name a version, so their bytes must not
# change; if a pin ever fails, bump the URL and the pin together, deliberately.
$TightVncSha256 = 'FA86D817AC29C5FFE1E8E7095E738D9BA5CA28AA62304AC234580916622A8CA2'
$UltraVncZipSha256 = '8AF948089626008F02EDD1254AFC15C814E454EC5FC9E3EAA860356F19D4F113'

# deviceinstaller64.exe carries NO Authenticode signature of its own (its PE
# certificate table is empty, checked 2026-09-07), and it is run elevated - by
# the driver install, by 'enableidd 1', and by the SYSTEM scheduled task. So it
# is pinned by hash, not by signature. Both pins were computed 2026-09-07 from
# the exact bytes $UsbmmiddUrl served on that day (zip 199,309 bytes;
# deviceinstaller64.exe 161,792 bytes).
#
# $UsbmmiddUrl is an UNVERSIONED "latest" link, so unlike the version-pinned
# downloads above, a routine vendor update legitimately changes these bytes: a
# mismatch here means "re-verify and re-pin", not automatically "attack". See
# $UsbmmiddRepinHelp for the procedure. Until it is re-pinned, this script
# refuses to run the executable.
$UsbmmiddZipSha256 = '629B51E9944762BAE73948171C65D09A79595CF4C771A82EBC003FBBA5B24F51'
$UsbmmiddExeSha256 = 'E9BAA02CDAE921ACF0AAE4D8E8C29A4CDF4057AB61F9C60862B7CC439E2753F7'

# The driver catalog usbmmidd.cat IS signed - WHQL, by "Microsoft Windows
# Hardware Compatibility Publisher" (Amyuni's driver, through Microsoft's
# hardware program). Windows validates it at install time, so it is kept as an
# extra check on top of the hash pins, not as a replacement for them.
$UsbmmiddSigner = 'Microsoft Windows Hardware Compatibility Publisher'

$UsbmmiddRepinHelp = @'
    usbmmidd_v2.zip is served from an UNVERSIONED "latest" URL, so a vendor
    update changes these bytes legitimately. To re-pin deliberately:
      1. Download https://amyuni.com/downloads/usbmmidd_v2.zip on a machine you trust.
      2. Get-FileHash .\usbmmidd_v2.zip -Algorithm SHA256
      3. Expand-Archive .\usbmmidd_v2.zip -DestinationPath .\usbmmidd_check
         Get-FileHash .\usbmmidd_check\usbmmidd_v2\deviceinstaller64.exe -Algorithm SHA256
      4. Confirm usbmmidd.cat is still Authenticode-Valid and signed by
         "Microsoft Windows Hardware Compatibility Publisher".
      5. Update $UsbmmiddZipSha256 and $UsbmmiddExeSha256 in this script, in one
         reviewed commit, with the date you verified them.
    Until then: plug in a monitor or an HDMI/DisplayPort dummy plug (~$8) and re-run.
'@

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal $id
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-PinnedHash {
    # $true when the downloaded file matches the pinned sha256.
    param([string]$Path, [string]$Expected, [string]$Label)
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Warning "$Label was not downloaded; nothing to verify."
        return $false
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -ne $Expected.ToUpperInvariant()) {
        Write-Warning "$Label sha256 mismatch - refusing to use it."
        Write-Warning "  expected: $Expected"
        Write-Warning "  got:      $actual"
        return $false
    }
    Write-Host "    $Label sha256 $actual verified"
    return $true
}

function Test-SignedBy {
    # Weaker than a pinned hash - only for downloads behind a moving URL.
    # Requires a Valid Authenticode status AND the expected signer subject.
    param([string]$Path, [string]$SignerMatch, [string]$Label)
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Warning "$Label is missing; cannot check its signature."
        return $false
    }
    $sig = $null
    try {
        $sig = Get-AuthenticodeSignature -LiteralPath $Path
    } catch {
        Write-Warning "$Label signature could not be read: $_"
        return $false
    }
    if (-not $sig -or $sig.Status -ne 'Valid') {
        $status = if ($sig) { $sig.Status } else { 'none' }
        Write-Warning "$Label Authenticode status is '$status', not 'Valid' - refusing to use it."
        return $false
    }
    $subject = ''
    if ($sig.SignerCertificate) { $subject = [string]$sig.SignerCertificate.Subject }
    if ($subject -notlike "*$SignerMatch*") {
        Write-Warning "$Label is signed by an unexpected publisher - refusing to use it."
        Write-Warning "  expected subject to contain: $SignerMatch"
        Write-Warning "  got: $subject"
        return $false
    }
    Write-Host "    $Label signature Valid, signer $subject"
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

function Test-OwnedByUsOrTrusted([string]$Path) {
    # True when $Path is owned by Administrators, SYSTEM, TrustedInstaller or
    # the account running this installer (not by some other local account
    # that could have created it first under C:\ProgramData).
    $owner = (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier])
    if (-not $owner) { return $false }
    if ($TrustedOwnerSids -contains $owner.Value) { return $true }
    return ($owner.Value -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
}

function Test-WritableByNonAdmins([string]$Path) {
    # True when anyone other than Administrators, SYSTEM or TrustedInstaller
    # owns $Path or may write, delete or re-permission it.
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if (-not $owner -or -not ($TrustedOwnerSids -contains $owner.Value)) { return $true }
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

function Test-ReadableByNonAdmins([string]$Path) {
    # True when anyone other than Administrators, SYSTEM or TrustedInstaller may read $Path.
    $acl = Get-Acl -LiteralPath $Path
    # ReadData, GENERIC_ALL, GENERIC_READ.
    $readMask = [long](0x1 -bor 0x10000000 -bor 0x80000000)
    foreach ($ace in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
        if ($ace.AccessControlType -ne 'Allow') { continue }
        if (($ace.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($TrustedOwnerSids -contains $ace.IdentityReference.Value) { continue }
        if (([long]$ace.FileSystemRights -band $readMask) -ne 0) { return $true }
    }
    return $false
}

function Test-ProtectedPath([string]$Path) {
    # Exists, is not a link, is owned by Administrators/SYSTEM/TrustedInstaller,
    # and nobody else may write, delete or re-permission it.
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if (Test-IsLink $Path) { return $false }
    return -not (Test-WritableByNonAdmins $Path)
}

function Test-TrustedExecutable([string]$Exe, [string[]]$ImportDirs = @()) {
    # $Exe can be run as Administrator or SYSTEM only when the file, every
    # folder above it that someone could rename or replace (up to, not
    # including, the drive root), and each folder it loads code from are
    # admin-only. Checked BEFORE the first time it is run.
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
            Write-Warning "$p can be changed by a non-administrator (or is a link); not running $Exe."
            return $false
        }
    }
    return $true
}

function Get-PythonImportDirs([string]$Exe) {
    $dir = Split-Path -Parent $Exe
    return @((Join-Path $dir 'Lib'), (Join-Path $dir 'Lib\site-packages'), (Join-Path $dir 'DLLs'))
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

Write-Host 'Computer viewer - Windows TightVNC + websockify bridge'
Write-Host "LAN / Tailscale only - VNC stays on 127.0.0.1:$VncPort; websocket on ${Bind}:$ListenPort."
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

function Protect-PasswordFile {
    # The whole ACL is replaced (no explicit grant survives) and checked; a
    # failure stops the install instead of leaving a readable password.
    Set-ProtectedAcl -Path $PasswordFile
    if ((Test-ReadableByNonAdmins $PasswordFile) -or (Test-WritableByNonAdmins $PasswordFile)) {
        throw "$PasswordFile is still readable or writable by non-administrators; refusing to use it."
    }
}

function Assert-TrustedStateDir {
    # C:\ProgramData\hermes-cv may already exist only if an administrator (or
    # this installer) made it. One another account created first is refused:
    # re-owning it would keep whatever was planted inside.
    if (-not (Test-Path -LiteralPath $StateDir)) {
        New-Item -ItemType Directory -Path $StateDir -ErrorAction Stop | Out-Null
        Set-ProtectedAcl -Path $StateDir
        return
    }
    if ((Test-IsLink $StateDir) -or -not (Test-OwnedByUsOrTrusted $StateDir)) {
        $owner = (Get-Acl -LiteralPath $StateDir).Owner
        throw "$StateDir already exists and is owned by '$owner' (or is a link), not by an administrator. Another account may have created it. Check it, delete it from an Administrator prompt (Remove-Item -Recurse -Force '$StateDir'), then re-run."
    }
}

function Get-OrCreateVncPassword {
    # A password file another account created first (a standard user may
    # create folders in C:\ProgramData) is never reused: that account would
    # know the password. Checked before the folder is re-owned below.
    $reuseOk = $false
    if ((Test-Path -LiteralPath $PasswordFile) -and -not (Test-IsLink $PasswordFile) -and -not (Test-IsLink $StateDir)) {
        $reuseOk = (Test-OwnedByUsOrTrusted $StateDir) -and (Test-OwnedByUsOrTrusted $PasswordFile)
        if (-not $reuseOk) { Write-Warning "$PasswordFile was not created by this installer; making a new VNC password." }
    }
    Assert-TrustedStateDir
    # The state folder: Administrators and SYSTEM only.
    # (The hiperf installer protects its own files inside it separately.)
    Set-ProtectedAcl -Path $StateDir
    if ($reuseOk) {
        $existing = (Get-Content -LiteralPath $PasswordFile -Raw -ErrorAction SilentlyContinue)
        if ($existing) {
            $existing = $existing.Trim()
            if ($existing.Length -ge 1) {
                Protect-PasswordFile
                Write-Step "Reusing VNC password stored in $PasswordFile"
                return $existing.Substring(0, [Math]::Min(8, $existing.Length))
            }
        }
    }
    if (Test-Path -LiteralPath $PasswordFile) { Remove-Item -LiteralPath $PasswordFile -Force }
    $pw = New-VncPassword8
    # Created empty, locked down, then written: the secret never sits in a file
    # with a wider ACL.
    New-Item -ItemType File -Path $PasswordFile -ErrorAction Stop | Out-Null
    Protect-PasswordFile
    Set-Content -LiteralPath $PasswordFile -Value $pw -Encoding ASCII
    Protect-PasswordFile
    Write-Step "Generated 8-char VNC password (DES limit) -> $PasswordFile"
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
    # Only an all-users install whose file, folders and import locations are
    # admin-only is returned; it is validated here, before it is ever run
    # (as Administrator now, as SYSTEM at every boot). Per-user installs and
    # anything on PATH that fails the check are skipped.
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

function ConvertTo-VncObfuscated([string]$Password) {
    # TightVNC's stored-password form: the 8-byte DES-ECB of the password
    # (zero padded) under VNC's fixed key, in standard DES bit order.
    $key = [byte[]](0xE8, 0x4A, 0xD6, 0x60, 0xC4, 0x72, 0x1A, 0xE0)
    $plain = New-Object byte[] 8
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($Password)
    [Array]::Copy($bytes, $plain, [Math]::Min(8, $bytes.Length))
    $des = [System.Security.Cryptography.DES]::Create()
    try {
        $des.Mode = [System.Security.Cryptography.CipherMode]::ECB
        $des.Padding = [System.Security.Cryptography.PaddingMode]::None
        $enc = $des.CreateEncryptor($key, (New-Object byte[] 8))
        return $enc.TransformFinalBlock($plain, 0, 8)
    } finally {
        $des.Dispose()
    }
}

function Set-TightVncPassword([string]$Password) {
    # The running server's password is the one in the file: set it, restart
    # the service, and read it back. A mismatch stops the install, so the
    # password printed below is always the one the server accepts.
    $want = ConvertTo-VncObfuscated $Password
    $rp = 'HKLM:\SOFTWARE\TightVNC\Server'
    if (-not (Test-Path -LiteralPath $rp)) { New-Item -Path $rp -Force | Out-Null }
    $have = (Get-ItemProperty -LiteralPath $rp -Name 'Password' -ErrorAction SilentlyContinue).Password
    $same = $have -and ($have.Length -eq 8) -and (-not (Compare-Object ([byte[]]$have) $want -SyncWindow 0))
    if (-not $same) {
        New-ItemProperty -Path $rp -Name 'Password' -PropertyType Binary -Value $want -Force | Out-Null
        New-ItemProperty -Path $rp -Name 'UseVncAuthentication' -PropertyType DWord -Value 1 -Force | Out-Null
        Write-Step 'Set the TightVNC server password to the one in the password file'
    }
    $check = (Get-ItemProperty -LiteralPath $rp -Name 'Password' -ErrorAction Stop).Password
    if (-not $check -or ($check.Length -ne 8) -or (Compare-Object ([byte[]]$check) $want -SyncWindow 0)) {
        throw 'The TightVNC server password could not be set to the stored one; not printing a password that would not work.'
    }
    return (-not $same)
}

function Get-DisplaySnapshot {
    $snap = [pscustomobject]@{
        Width = 0
        Height = 0
        MonitorCount = 0
        WinDisc = $false
        UsbMobile = $false
        UsbMobileAttached = $false
        DeviceNames = @()
    }
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $snap.Width = $vs.Width
        $snap.Height = $vs.Height
        $snap.MonitorCount = [System.Windows.Forms.SystemInformation]::MonitorCount
        foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
            $snap.DeviceNames += [string]$s.DeviceName
            if ([string]$s.DeviceName -match 'WinDisc') { $snap.WinDisc = $true }
        }
    } catch {
        # Session 0 / no WinForms is fine; other signals still work.
    }
    try {
        $devs = @(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue)
        foreach ($d in $devs) {
            if ($d.FriendlyName -match 'USB Mobile Monitor') {
                $snap.UsbMobile = $true
                if ($d.Status -eq 'OK') { $snap.UsbMobileAttached = $true }
            }
        }
    } catch {}
    try {
        $vc = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'USB Mobile Monitor' }
        foreach ($v in @($vc)) {
            if ($v.CurrentHorizontalResolution) { $snap.UsbMobileAttached = $true }
        }
    } catch {}
    return $snap
}

function Test-IsHeadlessDisplay {
    $s = Get-DisplaySnapshot
    if ($s.WinDisc) { return $true }
    if ($s.UsbMobile) { return $true }
    if ($s.MonitorCount -le 1 -and $s.Width -eq 1024 -and $s.Height -eq 768) { return $true }
    return $false
}

function Get-UltraVncPasswdHex {
    # UltraVNC passwd= is 8 obfuscated bytes as hex plus a 1-byte checksum
    # (2 hex chars) that UltraVNC ignores. TightVNC stores the same 8 bytes.
    try {
        $b = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\TightVNC\Server' -Name 'Password' -ErrorAction Stop).Password
        if ($b -and (@($b).Length -ge 8)) {
            $hex = ((@($b)[0..7] | ForEach-Object { $_.ToString('X2') }) -join '')
            if ($hex.Length -eq 16) { return ($hex + '00') }
        }
    } catch {}
    return $null
}

function Install-UsbmmiddVirtualDisplay {
    # Returns $true if a USB Mobile Monitor device is present after this call.
    $ErrorActionPreference = 'Continue'
    Write-Step 'Headless display: Amyuni usbmmidd_v2 virtual monitor'

    $already = $false
    try {
        $already = [bool](Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
            Where-Object { $_.FriendlyName -match 'USB Mobile Monitor' })
    } catch {}

    # The SYSTEM startup task runs a program from this folder. A folder that
    # someone else created (a standard user can create folders in C:\) or a
    # link is not adopted: stop, and drop any task that points into it.
    function Test-UsbmmiddDirTrusted {
        if (-not (Test-Path -LiteralPath $UsbmmiddDir)) { return $true }
        return (-not (Test-IsLink $UsbmmiddDir)) -and (Test-TrustedOwner $UsbmmiddDir)
    }
    function Stop-UntrustedUsbmmidd {
        $owner = (Get-Acl -LiteralPath $UsbmmiddDir).Owner
        Write-Warning "$UsbmmiddDir exists and is owned by '$owner', not Administrators, SYSTEM or TrustedInstaller (or it is a link)."
        Write-Warning 'Another account may have created it. Not installing the virtual display and not running anything from it.'
        Write-Warning "Check the folder, delete it from an Administrator prompt (Remove-Item -Recurse -Force '$UsbmmiddDir'), then re-run."
        try { Unregister-ScheduledTask -TaskName $UsbmmiddTaskName -Confirm:$false -ErrorAction Stop } catch {}
    }
    if (-not (Test-UsbmmiddDirTrusted)) { Stop-UntrustedUsbmmidd; return $false }

    $exe = Join-Path $UsbmmiddDir 'deviceinstaller64.exe'
    $inf = Join-Path $UsbmmiddDir 'usbmmidd.inf'
    if (-not (Test-Path -LiteralPath $inf)) {
        $inf = Join-Path $UsbmmiddDir 'usbmmIdd.inf'
    }

    # An installed copy is used only when its folder and exe are admin-only
    # (nobody else could have put files next to it) and the exe matches the
    # pin: 'enableidd 1' below and the SYSTEM task both execute it. Anything
    # else is replaced by a fresh copy from the hash-verified zip.
    $exeVerified = $false
    if ((Test-Path -LiteralPath $exe) -and (Test-ProtectedPath $UsbmmiddDir) -and (Test-ProtectedPath $exe)) {
        $exeVerified = Test-PinnedHash -Path $exe -Expected $UsbmmiddExeSha256 -Label 'installed deviceinstaller64.exe'
        if (-not $exeVerified) {
            Write-Warning 'The deviceinstaller64.exe already in C:\usbmmidd_v2 does not match the pin.'
            Write-Warning $UsbmmiddRepinHelp
            Write-Host '    Replacing it with a fresh copy from the pinned zip instead of running it.'
        }
    } elseif (Test-Path -LiteralPath $UsbmmiddDir) {
        Write-Host "    $UsbmmiddDir is not admin-only; replacing it with a fresh, verified copy."
    }

    if (-not $exeVerified) {
        $zip = Join-Path $env:TEMP 'usbmmidd_v2.zip'
        $extract = Join-Path $env:TEMP 'usbmmidd_extract'
        Write-Host "    Downloading $UsbmmiddUrl"
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $UsbmmiddUrl -OutFile $zip -UseBasicParsing -TimeoutSec 300
        } catch {
            Write-Warning "usbmmidd download failed: $_"
            Write-Warning 'Headless Windows has no display target. Plug in a monitor or an HDMI/DisplayPort dummy plug (~$8), then re-run.'
            return $false
        }
        # Verified BEFORE extraction: nothing from an unexpected archive is
        # written to disk, let alone executed.
        if (-not (Test-PinnedHash -Path $zip -Expected $UsbmmiddZipSha256 -Label 'usbmmidd_v2.zip')) {
            Write-Warning $UsbmmiddRepinHelp
            return $false
        }
        try {
            if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
            New-Item -ItemType Directory -Force -Path $extract | Out-Null
            Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
        } catch {
            Write-Warning "usbmmidd extract failed: $_"
            return $false
        }
        $installer = Get-ChildItem -LiteralPath $extract -Recurse -Filter 'deviceinstaller64.exe' | Select-Object -First 1
        if (-not $installer) {
            Write-Warning 'usbmmidd zip did not contain deviceinstaller64.exe'
            return $false
        }
        $srcDir = $installer.Directory.FullName
        # A fresh folder with a random name, created exclusively (it fails if
        # it exists) and made admin-only BEFORE any file lands in it. Only the
        # verified files go in. It then replaces the real folder by a rename.
        $stage = '{0}.new-{1}' -f $UsbmmiddDir, ([guid]::NewGuid().ToString('N').Substring(0, 12))
        try {
            New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
            Set-ProtectedAcl -Path $stage
            Copy-Item -Path (Join-Path $srcDir '*') -Destination $stage -Recurse -Force -ErrorAction Stop
            Set-ProtectedAcl -Path $stage -Recurse
        } catch {
            Write-Warning "Could not stage the driver files in $stage ($_). Not running anything."
            if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
            return $false
        }
        if (-not (Test-PinnedHash -Path (Join-Path $stage 'deviceinstaller64.exe') -Expected $UsbmmiddExeSha256 -Label 'staged deviceinstaller64.exe')) {
            Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
            Write-Warning $UsbmmiddRepinHelp
            return $false
        }
        # Revalidated right before the files are placed: a folder that
        # appeared during the download, or changed hands, is refused.
        if (-not (Test-UsbmmiddDirTrusted)) {
            Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
            Stop-UntrustedUsbmmidd
            return $false
        }
        try {
            if (Test-Path -LiteralPath $UsbmmiddDir) { Remove-Item -LiteralPath $UsbmmiddDir -Recurse -Force -ErrorAction Stop }
            # Fails if anyone re-created the folder in between: never merged.
            [System.IO.Directory]::Move($stage, $UsbmmiddDir)
        } catch {
            Write-Warning "Could not put the verified driver files in $UsbmmiddDir ($_). Not running anything from it."
            if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
            return $false
        }
        $exe = Join-Path $UsbmmiddDir 'deviceinstaller64.exe'
        $inf = Join-Path $UsbmmiddDir 'usbmmidd.inf'
        if (-not (Test-Path -LiteralPath $inf)) {
            $inf = Join-Path $UsbmmiddDir 'usbmmIdd.inf'
        }
        # Checked again where it will actually be run from.
        $exeVerified = (Test-ProtectedPath $UsbmmiddDir) -and (Test-ProtectedPath $exe) -and
            (Test-PinnedHash -Path $exe -Expected $UsbmmiddExeSha256 -Label 'deviceinstaller64.exe')
    }

    if (-not $exeVerified) {
        Write-Warning 'Refusing to run deviceinstaller64.exe: it does not match the pinned sha256.'
        Write-Warning $UsbmmiddRepinHelp
        return $false
    }

    if (-not $already) {
        # Extra gate, on top of the exe hash pin above: the driver catalog's
        # Authenticode signature, checked BEFORE the installer runs as admin.
        # It is what Windows itself validates when the .inf is installed.
        $catDir = Split-Path -Parent $exe
        $cat = Join-Path $catDir 'usbmmidd.cat'
        if (-not (Test-Path -LiteralPath $cat)) { $cat = Join-Path $catDir 'usbmmIdd.cat' }
        if (-not (Test-SignedBy -Path $cat -SignerMatch $UsbmmiddSigner -Label 'usbmmidd driver catalog')) {
            Write-Warning 'Not running deviceinstaller64.exe.'
            Write-Warning 'Fallback: plug in a monitor or an HDMI/DisplayPort dummy plug (~$8), then re-run.'
            return $false
        }
        Write-Host "    $exe install usbmmidd.inf usbmmidd"
        $outFile = Join-Path $env:TEMP 'usbmmidd-install-out.txt'
        $errFile = Join-Path $env:TEMP 'usbmmidd-install-err.txt'
        $p = Start-Process -FilePath $exe -ArgumentList 'install usbmmidd.inf usbmmidd' -WorkingDirectory $UsbmmiddDir -Wait -PassThru -NoNewWindow -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        $combined = ''
        if (Test-Path -LiteralPath $outFile) { $combined += (Get-Content -LiteralPath $outFile -Raw) }
        if (Test-Path -LiteralPath $errFile) { $combined += (Get-Content -LiteralPath $errFile -Raw) }
        if ($combined) { Write-Host $combined }
        Write-Host "    install exit=$($p.ExitCode)"
        if ($combined -match '0xE0000242|publisher trust|not digitally signed|cannot be verified|authenticode|not trusted') {
            Write-Warning 'usbmmidd signature was REJECTED on this Windows build. Not enabling test-signing and not importing certificates.'
            Write-Warning 'Fallback: plug in a monitor or an HDMI/DisplayPort dummy plug (~$8), then re-run. Cloud Windows VMs already have a hypervisor display and do not need this.'
            return $false
        }
        if ($p.ExitCode -ne 0 -and $combined -match 'trust|sign|0xE0000242|0x800B|cert') {
            Write-Warning 'usbmmidd signature was REJECTED on this Windows build. Stopping virtual-display install.'
            Write-Warning 'Fallback: HDMI/DisplayPort dummy plug (~$8).'
            return $false
        }
    } else {
        Write-Host '    USB Mobile Monitor already present - skipping driver install'
        Write-Host '    (deviceinstaller64.exe was still hash-verified above; enableidd runs it.)'
    }

    $snap = Get-DisplaySnapshot
    if (-not $snap.UsbMobileAttached) {
        Write-Host "    $exe enableidd 1"
        $p2 = Start-Process -FilePath $exe -ArgumentList 'enableidd 1' -WorkingDirectory $UsbmmiddDir -Wait -PassThru -NoNewWindow
        Write-Host "    enableidd exit=$($p2.ExitCode)"
    } else {
        Write-Host '    Virtual monitor already attached - not calling enableidd again (it would add another)'
    }

    try {
        $action = New-ScheduledTaskAction -Execute $exe -Argument 'enableidd 1'
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserID 'NT AUTHORITY\SYSTEM' -RunLevel Highest
        Register-ScheduledTask -TaskName $UsbmmiddTaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
        Write-Host "    Scheduled task $UsbmmiddTaskName (SYSTEM, AtStartup, enableidd 1)"
    } catch {
        Write-Warning "Could not register $UsbmmiddTaskName : $_"
    }

    try {
        Set-VirtualDisplay1920
    } catch {
        Write-Host "    Could not force 1920x1080 from this session: $_"
    }

    $after = Get-DisplaySnapshot
    Write-Host ("    Display now {0}x{1} monitors={2} usbmmidd={3}" -f $after.Width, $after.Height, $after.MonitorCount, $after.UsbMobile)
    return [bool](Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'USB Mobile Monitor' })
}

function Set-VirtualDisplay1920 {
    if (-not ([System.Management.Automation.PSTypeName]'ComputerViewerDisp').Type) {
        $cs = @'
using System;
using System.Runtime.InteropServices;
public static class ComputerViewerDisp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int ChangeDisplaySettingsEx(string lpszDeviceName, ref DEVMODE lpDevMode, IntPtr hwnd, uint dwflags, IntPtr lParam);
  [DllImport("user32.dll", EntryPoint = "ChangeDisplaySettingsExW", CharSet = CharSet.Unicode)]
  public static extern int ChangeDisplaySettingsExW(string lpszDeviceName, IntPtr lpDevMode, IntPtr hwnd, uint dwflags, IntPtr lParam);
  public static int SetUsb1920() {
    uint i = 0;
    string target = null;
    while (true) {
      DISPLAY_DEVICE d = new DISPLAY_DEVICE();
      d.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
      if (!EnumDisplayDevices(null, i, ref d, 0)) break;
      bool attached = (d.StateFlags & 1) != 0;
      bool usb = d.DeviceString != null && d.DeviceString.IndexOf("USB Mobile") >= 0;
      if (usb && attached) {
        target = d.DeviceName;
        if ((d.StateFlags & 4) != 0) break;
      }
      i++;
      if (i > 40) break;
    }
    if (target == null) return -99;
    DEVMODE dm = new DEVMODE();
    dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    dm.dmPelsWidth = 1920;
    dm.dmPelsHeight = 1080;
    dm.dmBitsPerPel = 32;
    dm.dmDisplayFrequency = 60;
    dm.dmPositionX = 0;
    dm.dmPositionY = 0;
    dm.dmFields = 0x00000020 | 0x00080000 | 0x00100000 | 0x00040000 | 0x00400000;
    uint flags = 0x00000001 | 0x10000000 | 0x00000010;
    int rc = ChangeDisplaySettingsEx(target, ref dm, IntPtr.Zero, flags, IntPtr.Zero);
    ChangeDisplaySettingsExW(null, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero);
    return rc;
  }
}
'@
        Add-Type -TypeDefinition $cs -ErrorAction Stop
    }
    $rc = [ComputerViewerDisp]::SetUsb1920()
    Write-Host "    Set 1920x1080 primary rc=$rc (0=success, -99=no attached USB monitor in this session)"
}

function Restore-TightVnc([string]$Why) {
    # Fail closed: UltraVNC is stopped and disabled, TightVNC serves :5900 again.
    Write-Warning "$Why Not using UltraVNC; TightVNC keeps serving :5900."
    try { Stop-Service -Name 'uvnc_service' -Force -ErrorAction SilentlyContinue } catch {}
    try { Set-Service -Name 'uvnc_service' -StartupType Disabled -ErrorAction SilentlyContinue } catch {}
    try { & taskkill.exe /F /IM winvnc.exe /T 2>$null | Out-Null } catch {}
    try {
        Set-Service -Name 'tvnserver' -StartupType Automatic -ErrorAction SilentlyContinue
        Start-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
    } catch {}
}

function Test-UltraVncIniText([string]$Text, [string]$PasswdHex, [int]$Port) {
    # The settings that keep UltraVNC private: the password is required and
    # set, and it listens on loopback only, on the expected port.
    if (-not $PasswdHex) { return $false }
    foreach ($want in @("passwd=$PasswdHex", 'AuthRequired=1', 'LoopbackOnly=1', 'AllowLoopback=1', "PortNumber=$Port")) {
        if ($Text -notmatch ('(?m)^' + [regex]::Escape($want) + '\r?$')) { return $false }
    }
    foreach ($bad in @('AuthRequired=0', 'LoopbackOnly=0')) {
        if ($Text -match ('(?m)^' + [regex]::Escape($bad))) { return $false }
    }
    return $true
}

function Test-UltraVncIni([string]$Path, [string]$PasswdHex) {
    # The file the service will read: admin-only and private (see above).
    if (-not (Test-ProtectedPath $Path)) { return $false }
    if (Test-ReadableByNonAdmins $Path) { return $false }
    $text = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    return (Test-UltraVncIniText $text $PasswdHex $VncPort)
}

function Test-LoopbackOnlyListener([int]$Port) {
    # Every listener on $Port is bound to 127.0.0.1 or ::1. No listener = false.
    $l = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($l.Count -eq 0) { return $false }
    foreach ($c in $l) {
        if (@('127.0.0.1', '::1') -notcontains $c.LocalAddress) { return $false }
    }
    return $true
}

function Install-UltraVncHeadlessFallback {
    Write-Step 'Headless capture: TightVNC DXGI is black on the virtual display; switching to UltraVNC hook/poll'
    $passwdHex = Get-UltraVncPasswdHex
    if (-not $passwdHex) {
        Write-Warning 'Could not read TightVNC Password blob to seed UltraVNC. Leaving TightVNC in place.'
        return $false
    }

    # Program Files\UltraVNC is admin-only by inheritance. One that exists but
    # isn't (a link, another owner, a user-writable entry) is not used.
    if ((Test-Path -LiteralPath $UltraVncDir) -and -not (Test-ProtectedPath $UltraVncDir)) {
        Write-Warning "$UltraVncDir can be changed by non-administrators (or is a link). Not using UltraVNC; TightVNC keeps serving :5900."
        return $false
    }
    $winvnc = Join-Path $UltraVncDir 'winvnc.exe'
    if (-not (Test-Path -LiteralPath $winvnc)) {
        $zip = Join-Path $env:TEMP 'UltraVNC.zip'
        $extract = Join-Path $env:TEMP 'ultravnc_extract'
        Write-Host "    Downloading $UltraVncZipUrl"
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $UltraVncZipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 300
        } catch {
            Write-Warning "UltraVNC download failed: $_"
            Write-Warning 'TightVNC will keep serving :5900. Expect a black picture on a headless IDD. Dummy-plug fallback still applies.'
            return $false
        }
        if (-not (Test-PinnedHash -Path $zip -Expected $UltraVncZipSha256 -Label 'UltraVNC zip')) {
            Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
            Write-Warning 'Not extracting or running UltraVNC. TightVNC keeps serving :5900.'
            return $false
        }
        try {
            if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
            New-Item -ItemType Directory -Force -Path $extract | Out-Null
            Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
        } catch {
            Write-Warning "UltraVNC extract failed: $_"
            return $false
        }
        $found = Get-ChildItem -LiteralPath $extract -Recurse -Filter 'winvnc.exe' |
            Sort-Object { if ($_.FullName -match 'x64') { 0 } else { 1 } } |
            Select-Object -First 1
        if (-not $found) {
            Write-Warning 'UltraVNC zip did not contain winvnc.exe'
            return $false
        }
        try {
            if (-not (Test-Path -LiteralPath $UltraVncDir)) { New-Item -ItemType Directory -Path $UltraVncDir -ErrorAction Stop | Out-Null }
            Set-ProtectedAcl -Path $UltraVncDir
            Copy-Item -Path (Join-Path $found.Directory.FullName '*') -Destination $UltraVncDir -Recurse -Force -ErrorAction Stop
            Set-ProtectedAcl -Path $UltraVncDir -Recurse
        } catch {
            Write-Warning "Could not place UltraVNC in $UltraVncDir ($_)."
            return $false
        }
    }
    if (-not (Test-TrustedExecutable $winvnc)) {
        Write-Warning "Not running $winvnc. TightVNC keeps serving :5900."
        return $false
    }

    $ini = @"
[ultravnc]
passwd=$passwdHex
passwd2=
[admin]
FileTransferEnabled=0
AuthRequired=1
SocketConnect=1
HTTPConnect=0
AutoPortSelect=0
PortNumber=$VncPort
AllowLoopback=1
LoopbackOnly=1
DisableTrayIcon=1
PollFullScreen=1
PollForeground=1
OnlyPollOnEvent=0
EnableDriver=0
EnableHook=1
EnableVirtual=0
TurboMode=1
CaptureAlphaBlending=0
rdpmode=0
"@
    # The ini holds the VNC password (reversible obfuscation) and the service's
    # AuthRequired/LoopbackOnly settings. It is written only where the service
    # reads it, machine-wide (no per-user copy), into folders that are made
    # admin-only BEFORE the file exists; then the file's own ACL is replaced
    # and the result is checked. Any failure stops here, before the service
    # is started.
    $iniDirs = @((Join-Path $env:ProgramData 'UltraVNC'), $UltraVncDir)
    foreach ($d in $iniDirs) {
        try {
            if (Test-Path -LiteralPath $d) {
                if ((Test-IsLink $d) -or -not (Test-OwnedByUsOrTrusted $d)) {
                    throw "$d was not created by an administrator (or is a link)"
                }
            } else {
                New-Item -ItemType Directory -Path $d -ErrorAction Stop | Out-Null
            }
            Set-ProtectedAcl -Path $d -Recurse
            if (-not (Test-ProtectedPath $d)) { throw "$d is still writable by non-administrators" }
            $f = Join-Path $d 'ultravnc.ini'
            if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction Stop }
            New-Item -ItemType File -Path $f -ErrorAction Stop | Out-Null
            Set-ProtectedAcl -Path $f
            Set-Content -LiteralPath $f -Value $ini -Encoding ASCII -ErrorAction Stop
            Set-ProtectedAcl -Path $f
            if (-not (Test-UltraVncIni $f $passwdHex)) { throw "$f did not verify (ACL, AuthRequired, LoopbackOnly or password)" }
        } catch {
            Restore-TightVnc "Could not write a protected ultravnc.ini in $d ($_)."
            return $false
        }
    }
    # The old per-user copy (an earlier version wrote one) would hold the password.
    if ($env:APPDATA) {
        $old = Join-Path $env:APPDATA 'UltraVNC\ultravnc.ini'
        if ((Test-Path -LiteralPath $old) -and -not (Test-IsLink $old)) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
    }

    try {
        Stop-Service -Name 'tvnserver' -Force -ErrorAction SilentlyContinue
        Set-Service -Name 'tvnserver' -StartupType Manual -ErrorAction SilentlyContinue
        Write-Host '    Stopped TightVNC tvnserver (Manual) so it does not steal :5900'
    } catch {}

    $svc = Get-Service -Name 'uvnc_service' -ErrorAction SilentlyContinue
    if (-not $svc) {
        $p = Start-Process -FilePath $winvnc -ArgumentList '-install' -WorkingDirectory $UltraVncDir -Wait -PassThru
        Write-Host "    winvnc -install exit=$($p.ExitCode)"
    }
    try {
        & taskkill.exe /F /IM winvnc.exe /T 2>$null | Out-Null
    } catch {}
    Start-Sleep -Seconds 1
    try {
        Set-Service -Name 'uvnc_service' -StartupType Automatic -ErrorAction Stop
        Start-Service -Name 'uvnc_service' -ErrorAction Stop
    } catch {
        Restore-TightVnc "Could not start uvnc_service: $_."
        return $false
    }
    # Running is not enough: it must be listening on loopback only.
    $ok = $false
    foreach ($i in 1..10) {
        Start-Sleep -Seconds 1
        if (Test-LoopbackOnlyListener $VncPort) { $ok = $true; break }
    }
    if (-not $ok) {
        Restore-TightVnc "uvnc_service is not listening on 127.0.0.1:$VncPort only."
        return $false
    }
    Write-Host "    Started uvnc_service (password required, 127.0.0.1:$VncPort only)"
    return $true
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
    if (-not (Test-PinnedHash -Path $msi -Expected $TightVncSha256 -Label 'TightVNC MSI')) {
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
        throw 'TightVNC MSI failed its pinned sha256 check. Refusing to run msiexec on it.'
    }
    Write-Step 'Installing TightVNC Server (service, SAS/CAD, VNC auth)'
    # The password is not passed to msiexec (a command line other accounts can
    # read); Set-TightVncPassword below writes it and checks it.
    $msiArgs = @(
        '/i', $msi,
        '/quiet', '/norestart',
        'ADDLOCAL=Server',
        'SERVER_REGISTER_AS_SERVICE=1',
        'SERVER_ALLOW_SAS=1',
        'SET_USEVNCAUTHENTICATION=1',
        'VALUE_OF_USEVNCAUTHENTICATION=1'
    )
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru
    if ($p.ExitCode -notin 0, 3010) {
        Write-Warning "msiexec exited $($p.ExitCode). TightVNC may already be present; continuing."
    }
} else {
    Write-Step 'TightVNC Server already installed - skipping MSI'
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

# The MSI's password property is unreliable and an existing install keeps its
# old password: make the server use exactly the stored one, then restart.
[void](Set-TightVncPassword $vncPassword)
try {
    $svc = Get-Service -Name 'tvnserver' -ErrorAction Stop
    if ($svc.Status -ne 'Running') {
        Start-Service -Name 'tvnserver'
    } else {
        Restart-Service -Name 'tvnserver' -Force
    }
    (Get-Service -Name 'tvnserver').WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
    Write-Step 'Restarted service tvnserver with the stored password'
} catch {
    throw "tvnserver is not running with the stored password ($_). Start TightVNC Server (Service Mode) from the Start menu, then re-run; no password is printed until it is."
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
    throw "No all-users Python 3.10+ with admin-only folders was found. Install it with: winget install -e --id Python.Python.3.12 --scope machine (or python.org, 'Install for all users'), then re-run."
}

Write-Step "Using Python: $python (all-users install, admin-only folders)"
Write-Step "Installing $WebsockifyPin (machine site-packages - SYSTEM scheduled task has no user PATH)"
& $python -I -m pip install $WebsockifyPin
if ($LASTEXITCODE -ne 0) {
    throw "pip install $WebsockifyPin failed (exit $LASTEXITCODE)."
}

# --- Scheduled Task (SYSTEM, at startup, no 72h kill) ----------------------

Write-Step "Registering scheduled task $TaskName (SYSTEM, AtStartup, ExecutionTimeLimit=0)"
# Default ExecutionTimeLimit is 72 hours - the task would be killed. Zero = unlimited.
$action = New-ScheduledTaskAction -Execute $python -Argument "-I -m websockify ${Bind}:$ListenPort 127.0.0.1:$VncPort"
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

# --- Headless virtual display + capture fallback ----------------------------
#
# Physically headless Windows (no monitor) renders a 1024x768 WinDisc stub.
# TightVNC then authenticates but the framebuffer is black. Cloud Windows VMs
# are fine: the hypervisor already provides a virtual display.
# usbmmidd is the free signed IDD that does not need test-signing or a third-
# party root CA (works on Home). enableidd does not survive reboot.

$script:UsedUltraVnc = $false
$script:UsbmmiddOk = $false
$headless = $false
try {
    $headless = Test-IsHeadlessDisplay
    $snap = Get-DisplaySnapshot
    Write-Host ("    Display snapshot: {0}x{1} monitors={2} WinDisc={3} usbmmidd={4}" -f $snap.Width, $snap.Height, $snap.MonitorCount, $snap.WinDisc, $snap.UsbMobile)
    if ($headless) {
        Write-Step 'Headless Windows detected (1024x768 / WinDisc / usbmmidd already present)'
        $script:UsbmmiddOk = Install-UsbmmiddVirtualDisplay
        if (-not $script:UsbmmiddOk) {
            Write-Warning 'Virtual display was not installed. VNC may stay black until a real monitor or HDMI/DisplayPort dummy plug is attached.'
        }
        $script:UsedUltraVnc = Install-UltraVncHeadlessFallback
        if (-not $script:UsedUltraVnc) {
            Write-Warning 'UltraVNC fallback did not start. TightVNC DXGI capture of an IDD / WinDisc is usually all-black on Windows 11.'
            Write-Warning 'If the picture is black: HDMI/DisplayPort dummy plug (~$8) plus TightVNC, or install UltraVNC in service mode (loopback, PollFullScreen, EnableHook).'
        }
    }
} catch {
    Write-Warning "Headless display setup failed (non-fatal): $_"
    Write-Warning 'Fallback: plug in a monitor or an HDMI/DisplayPort dummy plug (~$8), then re-run.'
}

# --- Summary ----------------------------------------------------------------

$hostname = $env:COMPUTERNAME
if (-not $hostname) {
    $hostname = [System.Net.Dns]::GetHostName()
}

Write-Host ''
Write-Host '===================================================================='
Write-Host 'Paste this address in Computer:'
if ($Bind -eq '127.0.0.1') {
    Write-Host '  Reach it through an SSH tunnel:'
    Write-Host ("    ssh -N -L {0}:127.0.0.1:{0} {1}@{2}" -f $ListenPort, $env:USERNAME, $hostname)
    Write-Host '  then paste:'
    Write-Host "    ws://127.0.0.1:${ListenPort}/websockify"
} elseif ($Bind -eq '0.0.0.0') {
    Write-Host "  ws://${hostname}:${ListenPort}/websockify"
    Write-Host '  Tailscale names work too: ws://<tailscale-name>:6080/websockify'
    Write-Host '  .local / MagicDNS both work on a private net.'
    Write-Host '  WARNING: bound to every interface, plaintext. LAN-only use.'
} else {
    Write-Host "  ws://${Bind}:${ListenPort}/websockify"
    Write-Host '  Tailscale names work too: ws://<tailscale-name>:6080/websockify'
    Write-Host '  .local / MagicDNS both work on a private net.'
}
Write-Host ''
Write-Host 'VNC password (paste into the plugin Password field):'
Write-Host "  $vncPassword"
Write-Host "Stored at $PasswordFile"
Write-Host ''
Write-Host 'Notes:'
Write-Host '  - Run in Administrator PowerShell (this script self-elevates).'
Write-Host '  - LAN / Tailscale only. Do not port-forward 5900 or 6080.'
Write-Host "  - TightVNC is loopback-only. websockify is bound to ${Bind}:$ListenPort."
Write-Host '  - UAC prompts show only in TightVNC service mode - they will. That is expected.'
Write-Host '  - Defender may flag VNC. Allow TightVNC / tvnserver if it quarantines it.'
if ($headless) {
    Write-Host '  - Headless: Amyuni usbmmidd virtual display (default 1920x1080).'
    Write-Host '    enableidd is re-applied at boot by task ComputerViewerVirtualDisplay.'
    if ($script:UsedUltraVnc) {
        Write-Host '  - Capture is UltraVNC (hook/poll) on 127.0.0.1:5900; TightVNC left installed but Manual.'
    }
    Write-Host '  - If the picture is still black: HDMI/DisplayPort dummy plug (~$8).'
}
Write-Host '===================================================================='
