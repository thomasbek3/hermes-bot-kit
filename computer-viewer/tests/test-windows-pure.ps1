# Pure-function tests for the Windows installers. Runs on any pwsh 7
# (Linux, macOS or Windows): the functions are lifted out of the scripts by
# their syntax tree, nothing in the scripts' body runs, and the ACL and
# network helpers they call are replaced by stubs.
#
#   pwsh -NoProfile -File computer-viewer/tests/test-windows-pure.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$script:failed = 0
$script:passed = 0

function Import-ScriptFunctions([string]$Path, [string[]]$Names) {
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$null, [ref]$errors)
    if ($errors.Count) { throw "$Path does not parse: $($errors[0])" }
    foreach ($name in $Names) {
        $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $false)
        if (-not $fn) { throw "$name not found in $Path" }
        . ([scriptblock]::Create($fn.Extent.Text.Replace("function $name", "function global:$name")))
    }
}

function Check([string]$Label, [bool]$Ok) {
    if ($Ok) { $script:passed++; Write-Host "ok   $Label" }
    else { $script:failed++; Write-Host "FAIL $Label" }
}

$connect = Join-Path $root 'connect-windows.ps1'
$hiperf = Join-Path $root 'hiperf-windows.ps1'

# --- TightVNC password form (F14) -------------------------------------------
Import-ScriptFunctions $connect @('ConvertTo-VncObfuscated')
# Expected values: DES-ECB under VNC's fixed key, computed independently with
# openssl (`openssl enc -des-ecb -K e84ad660c4721ae0 -nopad`); "password" ->
# dbd83cfd727a1458 is the well-known reference value.
$vectors = @{ 'password' = 'dbd83cfd727a1458'; 'test' = '2f981dc548e09ec2'; '12345678' = 'f0e43164f6c2e373'; 'abc' = '9c0a172d3482e122' }
foreach ($k in $vectors.Keys) {
    $hex = ((ConvertTo-VncObfuscated $k) | ForEach-Object { $_.ToString('x2') }) -join ''
    Check "VNC password form of '$k'" ($hex -eq $vectors[$k])
}
$long = ((ConvertTo-VncObfuscated 'password-and-more') | ForEach-Object { $_.ToString('x2') }) -join ''
Check 'only the first 8 characters count (VNC DES limit)' ($long -eq 'dbd83cfd727a1458')

# --- UltraVNC ini check (F2) ------------------------------------------------
Import-ScriptFunctions $connect @('Test-UltraVncIniText')
# The sample blob is built at run time (the privacy guard refuses any passwd= blob in the tree).
$blob = ((((ConvertTo-VncObfuscated 'password') | ForEach-Object { $_.ToString('X2') }) -join '') + '00')
$good = "[ultravnc]`r`npasswd=$blob`r`npasswd2=`r`n[admin]`r`nAuthRequired=1`r`nPortNumber=5900`r`nAllowLoopback=1`r`nLoopbackOnly=1`r`n"
Check 'ini with password, auth and loopback passes' (Test-UltraVncIniText $good $blob 5900)
Check 'ini with another password fails' (-not (Test-UltraVncIniText $good '0000000000000000AA' 5900))
Check 'ini without a password fails' (-not (Test-UltraVncIniText $good '' 5900))
Check 'ini with AuthRequired=0 fails' (-not (Test-UltraVncIniText ($good -replace 'AuthRequired=1', 'AuthRequired=0') $blob 5900))
Check 'ini with LoopbackOnly=0 fails' (-not (Test-UltraVncIniText ($good -replace 'LoopbackOnly=1', 'LoopbackOnly=0') $blob 5900))
Check 'ini with both LoopbackOnly=1 and =0 fails' (-not (Test-UltraVncIniText ($good + "LoopbackOnly=0`r`n") $blob 5900))
Check 'ini on another port fails' (-not (Test-UltraVncIniText $good $blob 5901))

# --- Loopback-only listener (F2) --------------------------------------------
Import-ScriptFunctions $connect @('Test-LoopbackOnlyListener')
function global:Get-NetTCPConnection { param($State, $LocalPort, $ErrorAction) $global:Listeners }
$global:Listeners = @([pscustomobject]@{ LocalAddress = '127.0.0.1' })
Check 'listener on 127.0.0.1 only passes' (Test-LoopbackOnlyListener 5900)
$global:Listeners = @([pscustomobject]@{ LocalAddress = '127.0.0.1' }, [pscustomobject]@{ LocalAddress = '::1' })
Check 'listeners on 127.0.0.1 and ::1 pass' (Test-LoopbackOnlyListener 5900)
$global:Listeners = @([pscustomobject]@{ LocalAddress = '127.0.0.1' }, [pscustomobject]@{ LocalAddress = '0.0.0.0' })
Check 'any listener on 0.0.0.0 fails' (-not (Test-LoopbackOnlyListener 5900))
$global:Listeners = @([pscustomobject]@{ LocalAddress = '192.168.1.5' })
Check 'listener on a LAN address fails' (-not (Test-LoopbackOnlyListener 5900))
$global:Listeners = @()
Check 'no listener fails (service not up)' (-not (Test-LoopbackOnlyListener 5900))

# --- Trusted executable walk (F1), both installers ----------------------------
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('cv-win-pure-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$pyDir = Join-Path (Join-Path $tmp 'Programs') 'Python312'
$libDir = Join-Path $pyDir 'Lib'
$siteDir = Join-Path $libDir 'site-packages'
New-Item -ItemType Directory -Force -Path $siteDir | Out-Null
$exe = Join-Path $pyDir 'python.exe'
Set-Content -LiteralPath $exe -Value '' -Encoding ASCII
try {
    foreach ($installer in @($connect, $hiperf)) {
        $label = Split-Path -Leaf $installer
        Import-ScriptFunctions $installer @('Test-TrustedExecutable')
        # Stub: a path is protected unless it is listed in $Unprotected.
        function global:Test-ProtectedPath([string]$Path) { return -not ($global:Unprotected -contains $Path) }
        function global:Write-Warning { param($Message) $global:Warned += , $Message }
        $imports = @($libDir, $siteDir, (Join-Path $pyDir 'DLLs'))

        $global:Unprotected = @(); $global:Warned = @()
        Check "${label}: protected exe and folders pass" (Test-TrustedExecutable $exe $imports)
        foreach ($case in @(
                @{ Name = 'the exe itself'; Path = $exe },
                @{ Name = 'its folder'; Path = $pyDir },
                @{ Name = 'a folder two levels up'; Path = $tmp },
                @{ Name = 'Lib'; Path = $libDir },
                @{ Name = 'Lib/site-packages'; Path = $siteDir })) {
            $global:Unprotected = @($case.Path); $global:Warned = @()
            $r = Test-TrustedExecutable $exe $imports
            Check "${label}: refused when $($case.Name) is writable by others" ((-not $r) -and ($global:Warned.Count -eq 1))
        }
        $global:Unprotected = @((Join-Path $pyDir 'DLLs'))
        Check "${label}: a missing import folder is not required" (Test-TrustedExecutable $exe $imports)
        Check "${label}: a missing exe is refused" (-not (Test-TrustedExecutable (Join-Path $pyDir 'nope.exe') @()))
        Remove-Item Function:\Test-ProtectedPath, Function:\Write-Warning
    }
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# --- No Python is run unvalidated, isolated mode everywhere (F1) ---------------
foreach ($installer in @($connect, $hiperf)) {
    $label = Split-Path -Leaf $installer
    $text = Get-Content -LiteralPath $installer -Raw
    Check "${label}: no per-user (LocalAppData) Python candidate" ($text -notmatch 'LocalAppData[^\r\n]*Python')
    $calls = [regex]::Matches($text, '(?m)^[^#\r\n]*&\s*\$(python|venvPython|Exe)\s+([^\r\n]*)')
    $bad = @($calls | Where-Object { $_.Groups[2].Value -notmatch '^-I\b' })
    Check "${label}: every Python invocation uses -I ($($calls.Count) found)" (($calls.Count -ge 2) -and ($bad.Count -eq 0))
    Check "${label}: no unpinned pip self-upgrade" ($text -notmatch 'pip install --upgrade pip')
}
$c = Get-Content -LiteralPath $connect -Raw
Check 'connect: websockify task runs python -I' ($c -match '-Argument "-I -m websockify')
Check 'connect: Resolve-Python validates before returning' ($c -match 'if \(Test-TrustedExecutable \$c \(Get-PythonImportDirs \$c\)\) \{ return \$c \}')
$msiArgs = [regex]::Match($c, '(?s)\$msiArgs = @\((.*?)\n    \)').Groups[1].Value
Check 'connect: the VNC password is not passed to msiexec' (($msiArgs -match 'ADDLOCAL=Server') -and ($msiArgs -notmatch 'PASSWORD'))
Check 'connect: no per-user ultravnc.ini copy is written' ($c -notmatch "iniDirs \+= \(Join-Path \`$env:APPDATA")
Check 'connect: Protect-PasswordFile does not swallow errors' ((Select-String -InputObject $c -Pattern '(?s)function Protect-PasswordFile \{(.*?)\n\}').Matches[0].Groups[1].Value -notmatch 'catch')
$h = Get-Content -LiteralPath $hiperf -Raw
Check 'hiperf: Resolve-Ffmpeg validates every candidate' ($h -match 'if \(Test-TrustedExecutable \$real\) \{ return \$real \}')
Check 'hiperf: a planted state tree is refused, not recreated' (($h -notmatch '\$planted') -and ($h -match 'Assert-TrustedTree \$HiperfDir'))

# --- HD venv reuse decision (round 3, item 4) ---------------------------------
Import-ScriptFunctions $hiperf @('Get-VenvAction')
$base = 'C:\Program Files\Python312'
$cfg = "home = $base`r`ninclude-system-site-packages = false`r`nversion = 3.12.7`r`n"
Check 'venv: built on the validated Python, good tree, launchers present -> reuse' ((Get-VenvAction -CfgText $cfg -ExpectedHome $base -TreeOk $true -ExesPresent $true) -eq 'reuse')
Check 'venv: home differs only in case and a trailing slash -> reuse' ((Get-VenvAction -CfgText "home = c:\program files\python312\`n" -ExpectedHome $base -TreeOk $true -ExesPresent $true) -eq 'reuse')
Check 'venv: home is another all-users Python -> rebuild' ((Get-VenvAction -CfgText ($cfg -replace 'Python312', 'Python311') -ExpectedHome $base -TreeOk $true -ExesPresent $true) -eq 'rebuild')
Check 'venv: home is a per-user Python -> rebuild' ((Get-VenvAction -CfgText 'home = C:\Users\someone\AppData\Local\Programs\Python\Python312' -ExpectedHome $base -TreeOk $true -ExesPresent $true) -eq 'rebuild')
Check 'venv: home is a prefix of the expected one only -> rebuild' ((Get-VenvAction -CfgText 'home = C:\Program Files\Python3' -ExpectedHome $base -TreeOk $true -ExesPresent $true) -eq 'rebuild')
Check 'venv: missing pyvenv.cfg -> rebuild' ((Get-VenvAction -CfgText '' -ExpectedHome $base -TreeOk $true -ExesPresent $true) -eq 'rebuild')
Check 'venv: pyvenv.cfg without home -> rebuild' ((Get-VenvAction -CfgText 'version = 3.12.7' -ExpectedHome $base -TreeOk $true -ExesPresent $true) -eq 'rebuild')
Check 'venv: two home lines -> rebuild' ((Get-VenvAction -CfgText ($cfg + "home = C:\Users\x\py`r`n") -ExpectedHome $base -TreeOk $true -ExesPresent $true) -eq 'rebuild')
Check 'venv: tree changeable by others -> rebuild' ((Get-VenvAction -CfgText $cfg -ExpectedHome $base -TreeOk $false -ExesPresent $true) -eq 'rebuild')
Check 'venv: python.exe or pythonw.exe missing -> rebuild' ((Get-VenvAction -CfgText $cfg -ExpectedHome $base -TreeOk $true -ExesPresent $false) -eq 'rebuild')

# Test-VenvTrusted / Find-UntrustedItem -Writable over a real folder, ACL helpers stubbed.
Import-ScriptFunctions $hiperf @('Test-VenvTrusted', 'Find-UntrustedItem', 'Remove-TreeNoFollow')
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('cv-win-venv-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$venv = Join-Path $tmp 'venv'
$scripts = Join-Path $venv 'Scripts'
New-Item -ItemType Directory -Force -Path $scripts | Out-Null
$pyHome = Join-Path $tmp 'Python312'
Set-Content -LiteralPath (Join-Path $venv 'pyvenv.cfg') -Value "home = $pyHome" -Encoding ASCII
foreach ($n in @('python.exe', 'pythonw.exe')) { Set-Content -LiteralPath (Join-Path $scripts $n) -Value '' -Encoding ASCII }
function global:Test-IsLink([string]$Path) { return ($global:Links -contains $Path) }
function global:Test-OwnedByUsOrTrusted([string]$Path) { return -not ($global:OtherOwner -contains $Path) }
function global:Test-WritableByNonAdmins([string]$Path) { return ($global:Writable -contains $Path) }
try {
    $pyExe = Join-Path $pyHome 'python.exe'
    $global:Links = @(); $global:OtherOwner = @(); $global:Writable = @()
    Check 'Test-VenvTrusted: a good venv passes' (Test-VenvTrusted -Dir $venv -Python $pyExe -TreeOk $true)
    Check 'Test-VenvTrusted: the tree as found was changeable -> fails' (-not (Test-VenvTrusted -Dir $venv -Python $pyExe -TreeOk $false))
    $global:Writable = @((Join-Path $scripts 'python.exe'))
    Check 'Test-VenvTrusted: a non-admin-writable launcher (ACL, owner fine) fails' (-not (Test-VenvTrusted -Dir $venv -Python $pyExe -TreeOk $true))
    $global:Writable = @(); $global:Links = @($scripts)
    Check 'Test-VenvTrusted: a link inside the venv fails' (-not (Test-VenvTrusted -Dir $venv -Python $pyExe -TreeOk $true))
    $global:Links = @(); $global:OtherOwner = @((Join-Path $venv 'pyvenv.cfg'))
    Check 'Test-VenvTrusted: an item owned by another account fails' (-not (Test-VenvTrusted -Dir $venv -Python $pyExe -TreeOk $true))
    $global:OtherOwner = @()
    $global:Writable = @($scripts)
    Check 'Find-UntrustedItem: without -Writable an ACL-only problem is not reported (round-2 owner check)' (-not (Find-UntrustedItem $venv))
    Check 'Find-UntrustedItem -Writable reports it' ((Find-UntrustedItem $venv -Writable) -eq $scripts)
    $global:Writable = @()
    Remove-Item -LiteralPath (Join-Path $scripts 'pythonw.exe')
    Check 'Test-VenvTrusted: missing pythonw.exe fails' (-not (Test-VenvTrusted -Dir $venv -Python $pyExe -TreeOk $true))
    Check 'Test-VenvTrusted: built on another Python fails' (-not (Test-VenvTrusted -Dir $venv -Python (Join-Path $tmp 'Python311\python.exe') -TreeOk $true))
} finally {
    Remove-Item Function:\Test-IsLink, Function:\Test-OwnedByUsOrTrusted, Function:\Test-WritableByNonAdmins
}

# --- Remove-TreeNoFollow: a link is removed as a link, its target kept ----------
$outside = Join-Path $tmp 'outside'
New-Item -ItemType Directory -Force -Path $outside | Out-Null
$keep = Join-Path $outside 'keep.txt'
Set-Content -LiteralPath $keep -Value 'x' -Encoding ASCII
$doomed = Join-Path $tmp 'doomed'
New-Item -ItemType Directory -Force -Path (Join-Path $doomed 'sub') | Out-Null
Set-Content -LiteralPath (Join-Path $doomed 'sub\f.txt') -Value 'y' -Encoding ASCII
$linked = $false
try {
    New-Item -ItemType SymbolicLink -Path (Join-Path $doomed 'sub\to-outside') -Target $outside -ErrorAction Stop | Out-Null
    New-Item -ItemType SymbolicLink -Path (Join-Path $doomed 'file-link') -Target $keep -ErrorAction Stop | Out-Null
    $linked = $true
} catch {
    Write-Host "skip symlink cases (cannot create links here: $_)"
}
Remove-TreeNoFollow $doomed
Check 'Remove-TreeNoFollow deletes the whole tree' (-not (Test-Path -LiteralPath $doomed))
if ($linked) {
    Check 'Remove-TreeNoFollow leaves a linked folder and file target intact' ((Test-Path -LiteralPath $keep) -and ((Get-Content -LiteralPath $keep -Raw).Trim() -eq 'x'))
}
Remove-TreeNoFollow (Join-Path $tmp 'does-not-exist')
Check 'Remove-TreeNoFollow on a missing path is a no-op' $true
$h = Get-Content -LiteralPath $hiperf -Raw
$venvBlock = [regex]::Match($h, '(?s)\$venvPython = Join-Path.*?Write-Step "Installing \$WebsocketsPin').Value
Check 'hiperf: the venv python runs only after Test-VenvTrusted' (($venvBlock -match 'if \(Test-VenvTrusted ') -and ($h.IndexOf('Test-VenvTrusted -Dir $VenvDir') -lt $h.IndexOf('& $venvPython -I -m pip')))
Check 'hiperf: a rejected venv is removed with the no-follow delete' (($venvBlock -match 'Remove-TreeNoFollow \$VenvDir') -and ($venvBlock -notmatch 'Remove-Item[^\r\n]*-Recurse'))
$firstProtect = [regex]::Match($h, '(?m)^Protect-HiperfState\s*$')
Check 'hiperf: the venv is rebuilt only after the HD tree is protected' ($firstProtect.Success -and ($firstProtect.Index -lt $h.IndexOf('& $python -I -m venv')))
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

# --- VNC password reuse decision (round 3, item 7) ----------------------------
Import-ScriptFunctions $connect @('Get-PasswordAction')
Check 'password: ours, private, valid -> reuse' ((Get-PasswordAction -Exists $true -OwnerOk $true -WasReadableByOthers $false -ContentOk $true) -eq 'reuse')
Check 'password: was readable or changeable by others -> rotate' ((Get-PasswordAction -Exists $true -OwnerOk $true -WasReadableByOthers $true -ContentOk $true) -eq 'rotate')
Check 'password: created by another account -> rotate' ((Get-PasswordAction -Exists $true -OwnerOk $false -WasReadableByOthers $false -ContentOk $true) -eq 'rotate')
Check 'password: empty or invalid content -> rotate' ((Get-PasswordAction -Exists $true -OwnerOk $true -WasReadableByOthers $false -ContentOk $false) -eq 'rotate')
Check 'password: no file -> rotate (new)' ((Get-PasswordAction -Exists $false -OwnerOk $false -WasReadableByOthers $false -ContentOk $false) -eq 'rotate')
$c = Get-Content -LiteralPath $connect -Raw
$pwFn = [regex]::Match($c, '(?s)function Get-OrCreateVncPassword \{(.*?)\n\}').Groups[1].Value
Check 'connect: readability is recorded before any ACL is tightened' (($pwFn.IndexOf('Test-ReadableByNonAdmins $PasswordFile') -ge 0) -and ($pwFn.IndexOf('Test-ReadableByNonAdmins $PasswordFile') -lt $pwFn.IndexOf('Set-ProtectedAcl')) -and ($pwFn.IndexOf('Test-ReadableByNonAdmins $PasswordFile') -lt $pwFn.IndexOf('Assert-TrustedStateDir')))
Check 'connect: rotation is announced in exactly one warning' (([regex]::Matches($pwFn, 'Write-Warning')).Count -eq 1)

# --- TightVNC read-back (round 3, item 7) -------------------------------------
Import-ScriptFunctions $connect @('Get-TightVncMismatch')
$TightVncDwords = @('UseVncAuthentication', 'AllowLoopback', 'LoopbackOnly')
$want = ConvertTo-VncObfuscated 'password'
function New-Props($Password, $Auth = 1, $Allow = 1, $Only = 1) {
    $o = [ordered]@{}
    if ($null -ne $Password) { $o.Password = [byte[]]$Password }
    if ($null -ne $Auth) { $o.UseVncAuthentication = [int]$Auth }
    if ($null -ne $Allow) { $o.AllowLoopback = [int]$Allow }
    if ($null -ne $Only) { $o.LoopbackOnly = [int]$Only }
    return [pscustomobject]$o
}
Check 'tightvnc: all four as written -> no mismatch' (@(Get-TightVncMismatch (New-Props $want) $want).Count -eq 0)
Check 'tightvnc: another password -> Password' ((@(Get-TightVncMismatch (New-Props (ConvertTo-VncObfuscated 'other')) $want) -join ',') -eq 'Password')
Check 'tightvnc: no password -> Password' ((@(Get-TightVncMismatch (New-Props $null) $want) -join ',') -eq 'Password')
Check 'tightvnc: a 7-byte password -> Password' ((@(Get-TightVncMismatch (New-Props ([byte[]]$want[0..6])) $want) -join ',') -eq 'Password')
Check 'tightvnc: UseVncAuthentication=0 -> named' ((@(Get-TightVncMismatch (New-Props $want 0) $want) -join ',') -eq 'UseVncAuthentication')
Check 'tightvnc: LoopbackOnly missing -> named' ((@(Get-TightVncMismatch (New-Props $want 1 1 $null) $want) -join ',') -eq 'LoopbackOnly')
Check 'tightvnc: AllowLoopback=0 and LoopbackOnly=0 -> both named' ((@(Get-TightVncMismatch (New-Props $want 1 0 0) $want) -join ',') -eq 'AllowLoopback,LoopbackOnly')
Check 'tightvnc: a string "1" is not a DWORD 1' ((@(Get-TightVncMismatch ([pscustomobject]@{ Password = $want; UseVncAuthentication = '1'; AllowLoopback = 1; LoopbackOnly = 1 }) $want) -join ',') -eq 'UseVncAuthentication')
Check 'tightvnc: nothing read back -> all named' (@(Get-TightVncMismatch $null $want).Count -eq 4)
$setFn = [regex]::Match($c, '(?s)function Set-TightVncPassword\(\[string\]\$Password\) \{(.*?)\n\}').Groups[1].Value
Check 'connect: Set-TightVncPassword writes every value with -ErrorAction Stop and checks the read-back' (($setFn -match "foreach \(\`$n in \`$TightVncDwords\)") -and ($setFn -match 'Get-TightVncMismatch \(Get-ItemProperty') -and ($setFn -notmatch 'SilentlyContinue'))
Check 'connect: the 64-bit key is no longer in the best-effort loopback loop' ($c -notmatch "(?m)^\s*'HKLM:\\SOFTWARE\\TightVNC\\Server',\s*$")

# --- UltraVNC recovery fails closed (round 3; only the kit's UltraVNC, round 4 item 7) ---
Import-ScriptFunctions $connect @('ConvertTo-NormalPath', 'Test-SamePath', 'Test-KitServicePath', 'Select-KitWinvnc', 'Get-PortConflict', 'Get-UvncServicePath', 'Restore-TightVnc')
$kitExe = 'C:\Program Files\UltraVNC\winvnc.exe'
$tvnExe = 'C:\Program Files\TightVNC\tvnserver.exe'
$kitProc = [pscustomobject]@{ Id = 4242; Name = 'winvnc'; Path = $kitExe }
$kitProc2 = [pscustomobject]@{ Id = 4244; Name = 'winvnc'; Path = 'c:/program files//ultravnc/WINVNC.EXE' }
$foreignProc = [pscustomobject]@{ Id = 5555; Name = 'winvnc'; Path = 'D:\Tools\UltraVNC\winvnc.exe' }
$noPathProc = [pscustomobject]@{ Id = 5556; Name = 'winvnc'; Path = $null }
$tvnProc = [pscustomobject]@{ Id = 900; Name = 'tvnserver'; Path = $tvnExe }

# Pure: which winvnc is the kit's, which service, who holds the port.
Check 'kit winvnc: of a kit and a foreign instance only the kit one is selected' (((@(Select-KitWinvnc -Processes @($kitProc, $foreignProc) -KitExe $kitExe) | ForEach-Object { $_.Id }) -join ',') -eq '4242')
Check 'kit winvnc: path case, / and doubled \ differences still match' ((@(Select-KitWinvnc -Processes @($kitProc2) -KitExe $kitExe)).Count -eq 1)
Check 'kit winvnc: a \\?\ prefixed path matches' ((@(Select-KitWinvnc -Processes @([pscustomobject]@{ Id = 1; Path = '\\?\C:\Program Files\UltraVNC\winvnc.exe' }) -KitExe $kitExe)).Count -eq 1)
Check 'kit winvnc: a process whose path cannot be read is not selected' ((@(Select-KitWinvnc -Processes @($noPathProc) -KitExe $kitExe)).Count -eq 0)
Check 'kit winvnc: winvnc in a sibling folder is not the kit' ((@(Select-KitWinvnc -Processes @([pscustomobject]@{ Id = 2; Path = 'C:\Program Files\UltraVNC2\winvnc.exe' }) -KitExe $kitExe)).Count -eq 0)
Check 'kit service: quoted PathName with -service' (Test-KitServicePath '"C:\Program Files\UltraVNC\winvnc.exe" -service' $kitExe)
Check 'kit service: unquoted PathName with -service' (Test-KitServicePath 'C:\Program Files\UltraVNC\winvnc.exe -service' $kitExe)
Check 'kit service: a PathName pointing elsewhere is not the kit' (-not (Test-KitServicePath '"D:\Tools\UltraVNC\winvnc.exe" -service' $kitExe))
Check 'kit service: empty PathName is not the kit' (-not (Test-KitServicePath '' $kitExe))
$c1 = Get-PortConflict -Listeners @([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 5555 }) -Processes @($foreignProc) -AllowedExes @($tvnExe)
Check 'port: a foreign listener is a conflict, with its path and PID' ($c1 -and ($c1.Path -eq 'D:\Tools\UltraVNC\winvnc.exe') -and ($c1.Pid -eq 5555))
Check 'port: a TightVNC listener is no conflict' ($null -eq (Get-PortConflict -Listeners @([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 900 }) -Processes @($tvnProc) -AllowedExes @($tvnExe)))
Check 'port: no listener is no conflict' ($null -eq (Get-PortConflict -Listeners @() -Processes @() -AllowedExes @($tvnExe)))
$c2 = Get-PortConflict -Listeners @([pscustomobject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 77 }) -Processes @() -AllowedExes @($tvnExe)
Check 'port: a listener whose process is unknown is a conflict' ($c2 -and ($c2.Pid -eq 77))
$c3 = Get-PortConflict -Listeners @([pscustomobject]@{ OwningProcess = 900 }, [pscustomobject]@{ OwningProcess = 5555 }) -Processes @($tvnProc, $foreignProc) -AllowedExes @($tvnExe)
Check 'port: TightVNC plus a foreign listener -> the foreign one is reported' ($c3 -and ($c3.Pid -eq 5555))

# Restore-TightVnc with stubbed services, processes and listeners.
$VncPort = 5900
$UltraVncDir = 'C:\Program Files\UltraVNC'
$savedPf = $env:ProgramFiles
$env:ProgramFiles = 'C:\Program Files'
function New-Svc([string]$Name, [string]$Status) {
    $o = [pscustomobject]@{ Name = $Name; Status = $Status }
    $o | Add-Member -MemberType ScriptMethod -Name WaitForStatus -Value {
        param($Want, $Timeout)
        if ($global:Stuck -contains $this.Name) { throw "Time out has expired and the operation has not been completed." }
        $this.Status = $Want
    }
    return $o
}
function global:Get-Service { param($Name, $ErrorAction) $s = $global:Services[$Name]; if (-not $s -and $ErrorAction -eq 'Stop') { throw "no service $Name" }; $s }
function global:Get-CimInstance { param($ClassName, $Filter, $ErrorAction) [pscustomobject]@{ Name = 'uvnc_service'; PathName = $global:UvncPathName } }
function global:Set-Service { param($Name, $StartupType, $ErrorAction) $global:Calls += "set $Name $StartupType" }
function global:Stop-Service { param($Name, [switch]$Force, $ErrorAction) $global:Calls += "stop $Name"; if ($global:Stuck -notcontains $Name) { $global:Services[$Name].Status = 'Stopped' } }
function global:Start-Service { param($Name, $ErrorAction) $global:Calls += "start $Name"; $global:Services[$Name].Status = 'Running'; if ($global:ListenAfterStart) { $global:Listeners = $global:ListenAfterStart } }
function global:Get-Process {
    param($Name, $Id, $ErrorAction)
    $p = @($global:Procs)
    if ($Name) { $p = @($p | Where-Object { $_.Name -eq $Name }) }
    if ($null -ne $Id) { $p = @($p | Where-Object { $_.Id -eq $Id }) }
    $p
}
function global:Stop-Process { param($Id, [switch]$Force, $ErrorAction) $global:Calls += "kill $Id"; if (-not $global:Unkillable) { $global:Procs = @($global:Procs | Where-Object { $_.Id -ne $Id }) } }
function global:Start-Sleep { param($Seconds) }
function global:Write-Warning { param($Message) $global:Warned += , $Message }
function Reset-Vnc([string]$Uvnc = 'Running', [object[]]$Procs = @(), [string[]]$Stuck = @(), [bool]$Unkillable = $false, [bool]$Listens = $true, [string]$UvncPath = ('"' + $kitExe + '" -service'), [object[]]$Holding = @()) {
    $global:Services = @{ 'tvnserver' = (New-Svc 'tvnserver' 'Stopped') }
    if ($Uvnc) { $global:Services['uvnc_service'] = (New-Svc 'uvnc_service' $Uvnc) }
    $global:UvncPathName = $UvncPath
    $global:Procs = $Procs; $global:Stuck = $Stuck; $global:Unkillable = $Unkillable
    $global:Calls = @(); $global:Warned = @(); $global:Listeners = $Holding
    $global:ListenAfterStart = $null
    if ($Listens) { $global:ListenAfterStart = @([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 900 }) }
}
function Invoke-Restore { try { Restore-TightVnc 'test.'; return 'ok' } catch { return "threw: $_" } }

Reset-Vnc
$r = Invoke-Restore
Check 'restore: UltraVNC stops, TightVNC comes back on loopback' (($r -eq 'ok') -and ($global:Services['uvnc_service'].Status -eq 'Stopped') -and ($global:Services['tvnserver'].Status -eq 'Running') -and ($global:Calls -contains 'set uvnc_service Disabled'))
Reset-Vnc -Uvnc $null
Check 'restore: no uvnc_service installed is fine' ((Invoke-Restore) -eq 'ok')
Reset-Vnc -Stuck @('uvnc_service')
$r = Invoke-Restore
Check 'restore: uvnc_service will not stop -> throws, TightVNC not started' (($r -like 'threw: UltraVNC (uvnc_service) could not be confirmed stopped*') -and ($global:Calls -notcontains 'start tvnserver'))
Reset-Vnc -Procs @($kitProc)
$r = Invoke-Restore
Check 'restore: a leftover kit winvnc.exe is killed, then TightVNC starts' (($r -eq 'ok') -and ($global:Calls -contains 'kill 4242') -and ($global:Procs.Count -eq 0))
Reset-Vnc -Procs @($kitProc) -Unkillable $true
$r = Invoke-Restore
Check 'restore: kit winvnc.exe survives the kill -> throws, TightVNC not started' (($r -like 'threw: winvnc.exe (UltraVNC*is still running*') -and ($global:Calls -notcontains 'start tvnserver'))
Reset-Vnc -Listens $false
$r = Invoke-Restore
Check 'restore: TightVNC not listening -> throws' ($r -like 'threw: TightVNC is running but not listening*')
Reset-Vnc
$global:ListenAfterStart = @([pscustomobject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 900 })
$r = Invoke-Restore
Check 'restore: TightVNC listening on every interface -> throws' ($r -like 'threw: TightVNC is running but not listening*')
Reset-Vnc -Stuck @('tvnserver')
$r = Invoke-Restore
Check 'restore: TightVNC never reaches Running -> throws' ($r -like 'threw: UltraVNC is stopped but TightVNC (tvnserver) could not be started*')
# Round 4 item 7: another UltraVNC is never stopped or killed.
Reset-Vnc -Procs @($kitProc, $foreignProc)
$r = Invoke-Restore
Check 'restore: only the kit winvnc is killed; a foreign winvnc is left running' (($r -eq 'ok') -and ($global:Calls -contains 'kill 4242') -and ($global:Calls -notcontains 'kill 5555') -and (@($global:Procs | Where-Object { $_.Id -eq 5555 }).Count -eq 1))
Reset-Vnc -Procs @($foreignProc) -Holding @([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 5555 })
$r = Invoke-Restore
Check 'restore: a foreign winvnc holding :5900 is reported, not killed; TightVNC not started' (($r -eq 'threw: Port 5900 is in use by D:\Tools\UltraVNC\winvnc.exe (PID 5555); stop it, then re-run.') -and ($global:Calls -notcontains 'kill 5555') -and ($global:Calls -notcontains 'start tvnserver'))
Reset-Vnc -UvncPath '"D:\Tools\UltraVNC\winvnc.exe" -service'
$r = Invoke-Restore
Check 'restore: a uvnc_service running another winvnc is not disabled or stopped' (($r -eq 'ok') -and (@($global:Calls | Where-Object { $_ -like '* uvnc_service*' }).Count -eq 0) -and ($global:Services['uvnc_service'].Status -eq 'Running') -and (@($global:Warned | Where-Object { $_ -like '*leaving it alone*' }).Count -eq 1))
Reset-Vnc -UvncPath '"D:\Tools\UltraVNC\winvnc.exe" -service' -Procs @($foreignProc) -Holding @([pscustomobject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 5555 })
$r = Invoke-Restore
Check 'restore: a foreign uvnc_service holding :5900 -> conflict reported, nothing touched' (($r -like 'threw: Port 5900 is in use by D:\Tools\UltraVNC\winvnc.exe (PID 5555)*') -and (@($global:Calls | Where-Object { $_ -like '*uvnc_service*' -or $_ -like 'kill*' }).Count -eq 0))
Reset-Vnc -Holding @([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 900 }) -Procs @($tvnProc)
Check 'restore: TightVNC already on :5900 is no conflict' ((Invoke-Restore) -eq 'ok')
Remove-Item Function:\Get-Service, Function:\Get-CimInstance, Function:\Set-Service, Function:\Stop-Service, Function:\Start-Service, Function:\Get-Process, Function:\Stop-Process, Function:\Start-Sleep, Function:\Write-Warning
$env:ProgramFiles = $savedPf
$restoreFn = [regex]::Match($c, '(?s)function Restore-TightVnc\(\[string\]\$Why\) \{(.*?)\n\}').Groups[1].Value
Check 'connect: Restore-TightVnc does not swallow service errors' (($restoreFn -notmatch 'catch \{\}') -and ($restoreFn -notmatch "(Stop|Set|Start)-Service -Name '(uvnc_service|tvnserver)'[^\r\n]*SilentlyContinue"))
Check 'connect: Restore-TightVnc kills only processes Select-KitWinvnc picked' (($restoreFn -match '\$left = @\(Select-KitWinvnc ') -and ($restoreFn -notmatch "Stop-Process -Name"))
$fallbackFn = [regex]::Match($c, '(?s)function Install-UltraVncHeadlessFallback \{(.*?)\n\}').Groups[1].Value
Check 'connect: the UltraVNC fallback no longer kills every winvnc.exe' (($fallbackFn -notmatch 'taskkill') -and ($fallbackFn -match 'Select-KitWinvnc -Processes'))
Check 'connect: the UltraVNC fallback leaves a foreign uvnc_service alone before stopping TightVNC' (($fallbackFn -match 'Test-KitServicePath \$uvncPath \$winvnc') -and ($fallbackFn.IndexOf('Test-KitServicePath') -lt $fallbackFn.IndexOf("Stop-Service -Name 'tvnserver'")))
Check 'connect: an UltraVNC failure is outside the non-fatal headless catch' ($c -match '(?s)\nif \(\$headless\) \{\s*#[^\n]*\n(\s*#[^\n]*\n)*\s*try \{\s*\$script:UsedUltraVnc = Install-UltraVncHeadlessFallback\s*\} catch \{\s*\$script:UsedUltraVnc = \$false\s*Restore-TightVnc')
Check 'connect: no Remove-Item -Recurse on C:\usbmmidd_v2' ($c -notmatch 'Remove-Item -LiteralPath \$UsbmmiddDir -Recurse')

# --- TightVNC registry key readable by others (round 3) -----------------------
Import-ScriptFunctions $connect @('Test-AclReadableByOthers')
$global:TrustedOwnerSids = @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function New-Rule($Sid, [long]$Rights, $Type = 'Allow', $Prop = 'None') {
    [pscustomobject]@{ AccessControlType = $Type; PropagationFlags = [System.Security.AccessControl.PropagationFlags]$Prop
        IdentityReference = [pscustomobject]@{ Value = $Sid }; RegistryRights = $Rights }
}
$users = 'S-1-5-32-545'
Check 'registry: Users with ReadKey is exposed' (Test-AclReadableByOthers @((New-Rule 'S-1-5-32-544' 0xF003F), (New-Rule $users 0x20019)) 'RegistryRights')
Check 'registry: Administrators and SYSTEM only is not exposed' (-not (Test-AclReadableByOthers @((New-Rule 'S-1-5-32-544' 0xF003F), (New-Rule 'S-1-5-18' 0xF003F)) 'RegistryRights'))
Check 'registry: a Deny rule for Users is not exposure' (-not (Test-AclReadableByOthers @((New-Rule $users 0x20019 'Deny')) 'RegistryRights'))
Check 'registry: an inherit-only Users rule does not apply to the key' (-not (Test-AclReadableByOthers @((New-Rule $users 0x20019 'Allow' 'InheritOnly')) 'RegistryRights'))
Check 'registry: GENERIC_READ for Users is exposed' (Test-AclReadableByOthers @((New-Rule $users 0x80000000)) 'RegistryRights')
$c3 = Get-Content -LiteralPath $connect -Raw
# Round 4 item 5: the key is locked and checked BEFORE the new password is written.
$setFn4 = [regex]::Match($c3, '(?s)function Set-TightVncPassword\(\[string\]\$Password\) \{(.*?)\n\}').Groups[1].Value
$iProtect = [regex]::Match($setFn4, '(?m)^\s*Protect-TightVncKey\s*$').Index
$iWritePw = $setFn4.IndexOf("New-ItemProperty -Path `$rp -Name 'Password'")
Check 'connect: the TightVNC key is locked before the password is written' (($iProtect -ge 0) -and ($iWritePw -gt $iProtect) -and ($setFn4.IndexOf('New-Item -Path $rp') -lt $iProtect))
Check 'connect: the key lock is checked again after the writes' ($setFn4 -match '(?s)if \(\$bad\.Count\) \{.*?\}\s*if \(Test-TightVncKeyExposed\) \{ throw')
Check 'connect: an exposed TightVNC key forces a rotation' ($c3 -match '\$keyExposed = Test-TightVncKeyExposed; \$exposed = \$keyExposed')

# --- Set-TightVncPassword call order (round 4, item 5) ------------------------
Import-ScriptFunctions $connect @('Set-TightVncPassword')
$TightVncKey = 'HKLM:\SOFTWARE\TightVNC\Server'
function global:Test-Path { param($LiteralPath, $Path, $PathType) $global:KeyExists }
function global:New-Item { param($Path, [switch]$Force, $ErrorAction, $ItemType) $global:Calls += 'create key' }
function global:Get-ItemProperty { param($LiteralPath, $Name, $ErrorAction) $global:Calls += 'read'; [pscustomobject]$global:Reg }
function global:New-ItemProperty { param($Path, $Name, $PropertyType, $Value, [switch]$Force, $ErrorAction) $global:Calls += "write $Name"; $global:Reg[$Name] = $Value }
function global:Protect-TightVncKey { $global:Calls += 'protect'; if ($global:ProtectFails) { throw 'still readable by non-administrators' } }
function global:Test-TightVncKeyExposed { $global:Calls += 'check'; $global:ExposedAfter }
function global:Write-Step { param($Message) }
function Invoke-SetPw { try { [void](Set-TightVncPassword 'password'); return 'ok' } catch { return "threw: $_" } }
function Reset-Reg([bool]$Exists = $true) { $global:KeyExists = $Exists; $global:Reg = [ordered]@{}; $global:Calls = @(); $global:ProtectFails = $false; $global:ExposedAfter = $false }
try {
    Reset-Reg
    $r = Invoke-SetPw
    $iP = [array]::IndexOf($global:Calls, 'protect'); $iW = [array]::IndexOf($global:Calls, 'write Password')
    Check 'set password: key locked before the password is written' (($r -eq 'ok') -and ($iP -ge 0) -and ($iW -gt $iP))
    Check 'set password: the lock is checked again after the writes and read-back' ($global:Calls[-1] -eq 'check')
    Reset-Reg -Exists $false
    $r = Invoke-SetPw
    Check 'set password: a missing key is created, then locked, then written' (($r -eq 'ok') -and ($global:Calls[0] -eq 'create key') -and ([array]::IndexOf($global:Calls, 'protect') -lt [array]::IndexOf($global:Calls, 'write Password')))
    Reset-Reg; $global:ProtectFails = $true
    $r = Invoke-SetPw
    Check 'set password: a failed lock stops before anything is written' (($r -like 'threw: *still readable*') -and (@($global:Calls | Where-Object { $_ -like 'write *' }).Count -eq 0))
    Reset-Reg; $global:ExposedAfter = $true
    Check 'set password: a key readable after the writes throws' ((Invoke-SetPw) -like 'threw: *readable by non-administrators after the password was written*')
} finally {
    Remove-Item Function:\Test-Path, Function:\New-Item, Function:\Get-ItemProperty, Function:\New-ItemProperty, Function:\Protect-TightVncKey, Function:\Test-TightVncKeyExposed, Function:\Write-Step
}

# --- HD token rotation when its original ACL exposed it (round 4, item 6) ------
Import-ScriptFunctions $hiperf @('Get-PasswordAction', 'Test-TokenAclExposed', 'Get-OrCreateToken')
$me = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
function New-FsRule($Sid, [long]$Rights, $Type = 'Allow', $Prop = 'None') {
    [pscustomobject]@{ AccessControlType = $Type; PropagationFlags = [System.Security.AccessControl.PropagationFlags]$Prop
        IdentityReference = [pscustomobject]@{ Value = $Sid }; FileSystemRights = $Rights }
}
$adminFull = New-FsRule 'S-1-5-32-544' 0x1F01FF
$systemFull = New-FsRule 'S-1-5-18' 0x1F01FF
$meRead = New-FsRule $me 0x120089
function Get-TokenDecision([object[]]$Rules, [bool]$OwnerOk = $true) {
    $exposed = $false
    if ($OwnerOk) { $exposed = Test-TokenAclExposed $Rules $me }
    return (Get-PasswordAction -Exists $true -OwnerOk $OwnerOk -WasReadableByOthers $exposed -ContentOk $true)
}
Check 'token: admins, SYSTEM and the install user with Read -> reuse' ((Get-TokenDecision @($adminFull, $systemFull, $meRead)) -eq 'reuse')
Check 'token: Users may read (inherited ProgramData ACL) -> rotate' ((Get-TokenDecision @($adminFull, $systemFull, $meRead, (New-FsRule 'S-1-5-32-545' 0x1200A9))) -eq 'rotate')
Check 'token: Users may write (WriteData only) -> rotate' ((Get-TokenDecision @($adminFull, $meRead, (New-FsRule 'S-1-5-32-545' 0x2))) -eq 'rotate')
Check 'token: the install user holds Modify, more than Read -> rotate' ((Get-TokenDecision @($adminFull, $systemFull, (New-FsRule $me 0x1301BF))) -eq 'rotate')
Check 'token: Authenticated Users GENERIC_READ -> rotate' ((Get-TokenDecision @($adminFull, (New-FsRule 'S-1-5-11' 0x80000000))) -eq 'rotate')
Check 'token: owned by another account -> rotate' ((Get-TokenDecision @($adminFull, $systemFull, $meRead) -OwnerOk $false) -eq 'rotate')
Check 'token: an inherit-only Users rule does not apply to the file -> reuse' ((Get-TokenDecision @($adminFull, $meRead, (New-FsRule 'S-1-5-32-545' 0x1200A9 'Allow' 'InheritOnly'))) -eq 'reuse')
Check 'token: a Deny rule for Users is not exposure -> reuse' ((Get-TokenDecision @($adminFull, $meRead, (New-FsRule 'S-1-5-32-545' 0x1F01FF 'Deny'))) -eq 'reuse')

# Get-OrCreateToken with stubbed file operations: it decides from the recorded state.
$TokenFile = 'C:\ProgramData\hermes-cv\hiperf-token.txt'
$InstallUser = 'PC\someone'
$oldTok = 'AB' * 16
function global:Get-Content { param($LiteralPath, [switch]$Raw, $ErrorAction) $global:Calls += 'read'; $oldTok }
function global:New-HiperfToken { 'cd' * 16 }
function global:Remove-TreeNoFollow { param($Path) $global:Calls += 'remove' }
function global:New-Item { param($ItemType, $Path, $ErrorAction) $global:Calls += 'create' }
function global:Set-ProtectedAcl { param($Path, $Extra) $global:Calls += 'protect' }
function global:Set-Content { param($LiteralPath, $Value, $Encoding) $global:Calls += 'write' }
function global:Write-Step { param($Message) }
function global:Write-Warning { param($Message) $global:Warned += , $Message }
try {
    $global:Calls = @(); $global:Warned = @()
    $t = Get-OrCreateToken @{ Exists = $true; OwnerOk = $true; Exposed = $false }
    Check 'token: a clean recorded state reuses the stored token' (($t -eq $oldTok.ToLowerInvariant()) -and ($global:Calls -notcontains 'write') -and ($global:Warned.Count -eq 0))
    $global:Calls = @(); $global:Warned = @()
    $t = Get-OrCreateToken @{ Exists = $true; OwnerOk = $true; Exposed = $true }
    Check 'token: an exposed recorded state rotates, in one warning, created locked then written' (($t -eq ('cd' * 16)) -and ($global:Warned.Count -eq 1) -and ($global:Calls -notcontains 'read') -and (($global:Calls -join ',') -eq 'remove,create,protect,write'))
    $global:Calls = @(); $global:Warned = @()
    $t = Get-OrCreateToken @{ Exists = $false; OwnerOk = $false; Exposed = $false }
    Check 'token: no token yet -> a new one, no warning' (($t -eq ('cd' * 16)) -and ($global:Warned.Count -eq 0))
} finally {
    Remove-Item Function:\Get-Content, Function:\New-HiperfToken, Function:\Remove-TreeNoFollow, Function:\New-Item, Function:\Set-ProtectedAcl, Function:\Set-Content, Function:\Write-Step, Function:\Write-Warning
}
$h4 = Get-Content -LiteralPath $hiperf -Raw
$iState = $h4.IndexOf('$tokenState = Get-TokenState')
$firstProtect4 = [regex]::Match($h4, '(?m)^Protect-HiperfState\s*$')
$tokenAcl = [regex]::Match($h4, '(?m)^Set-ProtectedAcl -Path \$TokenFile')
Check 'hiperf: the token ACL is recorded before the first tightening call' (($iState -ge 0) -and $firstProtect4.Success -and ($iState -lt $firstProtect4.Index) -and ($iState -lt $h4.IndexOf('$token = Get-OrCreateToken $tokenState')) -and $tokenAcl.Success -and ($iState -lt $tokenAcl.Index))
$tokFn = [regex]::Match($h4, '(?s)function Get-OrCreateToken\(\$State\) \{(.*?)\n\}').Groups[1].Value
Check 'hiperf: Get-OrCreateToken uses the recorded state, warns once, deletes without following links' (($tokFn -notmatch 'Get-Acl|Test-OwnedByUsOrTrusted') -and (([regex]::Matches($tokFn, 'Write-Warning')).Count -eq 1) -and ($tokFn -match 'Remove-TreeNoFollow \$TokenFile') -and ($tokFn -notmatch 'Remove-Item'))

Write-Host ''
Write-Host "$script:passed passed, $script:failed failed"
if ($script:failed) { exit 1 }
