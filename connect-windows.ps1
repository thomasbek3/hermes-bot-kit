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
  the properties). We still pass them, print the generated password regardless,
  and may need a registry / TightVNC configuration fallback for auth.

  Headless PCs (no monitor, VirtualScreen 1024x768 / WinDisc): install Amyuni
  usbmmidd_v2 (signed IDD, no test-signing) and persist enableidd at startup.
  TightVNC's DXGI grab of that IDD is black on Win11; switch capture to UltraVNC
  hook/poll on loopback :5900. Non-fatal if the driver signature is rejected -
  print the HDMI dummy-plug fallback. Machines with a real monitor are unchanged.
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
$UsbmmiddUrl = 'https://amyuni.com/downloads/usbmmidd_v2.zip'
$UsbmmiddDir = 'C:\usbmmidd_v2'
$UsbmmiddTaskName = 'ComputerViewerVirtualDisplay'
$UltraVncZipUrl = 'https://uvnc.eu/download/1800/UltraVNC_1824.zip'
$UltraVncDir = Join-Path ${env:ProgramFiles} 'UltraVNC'

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

Write-Host 'Computer viewer - Windows TightVNC + websockify bridge'
Write-Host "LAN / Tailscale only - VNC stays on 127.0.0.1:$VncPort; websocket on 0.0.0.0:$ListenPort."
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

    $exe = Join-Path $UsbmmiddDir 'deviceinstaller64.exe'
    $inf = Join-Path $UsbmmiddDir 'usbmmidd.inf'
    if (-not (Test-Path -LiteralPath $inf)) {
        $inf = Join-Path $UsbmmiddDir 'usbmmIdd.inf'
    }

    if (-not (Test-Path -LiteralPath $exe)) {
        $zip = Join-Path $env:TEMP 'usbmmidd_v2.zip'
        $extract = Join-Path $env:TEMP 'usbmmidd_extract'
        Write-Host "    Downloading $UsbmmiddUrl"
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $UsbmmiddUrl -OutFile $zip -UseBasicParsing
        } catch {
            Write-Warning "usbmmidd download failed: $_"
            Write-Warning 'Headless Windows has no display target. Plug in a monitor or an HDMI/DisplayPort dummy plug (~$8), then re-run.'
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
        New-Item -ItemType Directory -Force -Path $UsbmmiddDir | Out-Null
        Copy-Item -Path (Join-Path $srcDir '*') -Destination $UsbmmiddDir -Recurse -Force
        $exe = Join-Path $UsbmmiddDir 'deviceinstaller64.exe'
        $inf = Join-Path $UsbmmiddDir 'usbmmidd.inf'
        if (-not (Test-Path -LiteralPath $inf)) {
            $inf = Join-Path $UsbmmiddDir 'usbmmIdd.inf'
        }
    }

    if (-not $already) {
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

function Install-UltraVncHeadlessFallback {
    Write-Step 'Headless capture: TightVNC DXGI is black on the virtual display; switching to UltraVNC hook/poll'
    $passwdHex = Get-UltraVncPasswdHex
    if (-not $passwdHex) {
        Write-Warning 'Could not read TightVNC Password blob to seed UltraVNC. Leaving TightVNC in place.'
        return $false
    }

    $winvnc = Join-Path $UltraVncDir 'winvnc.exe'
    if (-not (Test-Path -LiteralPath $winvnc)) {
        $zip = Join-Path $env:TEMP 'UltraVNC.zip'
        $extract = Join-Path $env:TEMP 'ultravnc_extract'
        Write-Host "    Downloading $UltraVncZipUrl"
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $UltraVncZipUrl -OutFile $zip -UseBasicParsing
        } catch {
            Write-Warning "UltraVNC download failed: $_"
            Write-Warning 'TightVNC will keep serving :5900. Expect a black picture on a headless IDD. Dummy-plug fallback still applies.'
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
        New-Item -ItemType Directory -Force -Path $UltraVncDir | Out-Null
        Copy-Item -Path (Join-Path $found.Directory.FullName '*') -Destination $UltraVncDir -Recurse -Force
        $winvnc = Join-Path $UltraVncDir 'winvnc.exe'
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
    $iniDirs = @(
        (Join-Path $env:ProgramData 'UltraVNC'),
        $UltraVncDir
    )
    if ($env:APPDATA) { $iniDirs += (Join-Path $env:APPDATA 'UltraVNC') }
    foreach ($d in $iniDirs) {
        try {
            New-Item -ItemType Directory -Force -Path $d | Out-Null
            Set-Content -LiteralPath (Join-Path $d 'ultravnc.ini') -Value $ini -Encoding ASCII
        } catch {
            Write-Warning "Could not write ultravnc.ini in $d : $_"
        }
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
        Set-Service -Name 'uvnc_service' -StartupType Automatic -ErrorAction SilentlyContinue
        Start-Service -Name 'uvnc_service' -ErrorAction Stop
        Write-Host '    Started uvnc_service'
    } catch {
        Write-Warning "Could not start uvnc_service: $_"
        try { Start-Service -Name 'tvnserver' -ErrorAction SilentlyContinue } catch {}
        return $false
    }
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
    Write-Step 'Installing TightVNC Server (service, SAS/CAD, VNC auth)'
    # MSI password properties are unreliable - see header comment. Print $vncPassword later regardless.
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
Write-Step "Installing $WebsockifyPin (machine site-packages - SYSTEM scheduled task has no user PATH)"
& $python -m pip install --upgrade pip | Out-Null
& $python -m pip install $WebsockifyPin
if ($LASTEXITCODE -ne 0) {
    throw "pip install $WebsockifyPin failed (exit $LASTEXITCODE)."
}

# --- Scheduled Task (SYSTEM, at startup, no 72h kill) ----------------------

Write-Step "Registering scheduled task $TaskName (SYSTEM, AtStartup, ExecutionTimeLimit=0)"
# Default ExecutionTimeLimit is 72 hours - the task would be killed. Zero = unlimited.
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
Write-Host '  - UAC prompts show only in TightVNC service mode - they will. That is expected.'
Write-Host '  - Defender may flag VNC. Allow TightVNC / tvnserver if it quarantines it.'
Write-Host '  - Tailscale names work too: ws://<tailscale-name>:6080/websockify'
Write-Host '  - .local / MagicDNS both work on a private net.'
if ($headless) {
    Write-Host '  - Headless: Amyuni usbmmidd virtual display (default 1920x1080).'
    Write-Host '    enableidd is re-applied at boot by task ComputerViewerVirtualDisplay.'
    if ($script:UsedUltraVnc) {
        Write-Host '  - Capture is UltraVNC (hook/poll) on 127.0.0.1:5900; TightVNC left installed but Manual.'
    }
    Write-Host '  - If the picture is still black: HDMI/DisplayPort dummy plug (~$8).'
}
Write-Host '===================================================================='
