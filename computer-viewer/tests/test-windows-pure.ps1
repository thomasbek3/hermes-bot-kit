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

Write-Host ''
Write-Host "$script:passed passed, $script:failed failed"
if ($script:failed) { exit 1 }
