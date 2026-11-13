# IPC regression checks only. No vendor DLL, account or camera is needed.
$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('camera-sdk-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $executable = Join-Path $temporary 'CameraTalkSdkTest.exe'
    $arguments = @('/nologo','/platform:x64','/r:System.Web.Extensions.dll','/r:System.Security.dll',"/resource:$source\RuntimeHashes.json,RuntimeHashes.json","/out:$executable")
    $arguments += @(Get-ChildItem -LiteralPath $source -Filter '*.cs' | ForEach-Object FullName)
    & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed' }
    $agent = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($executable)).GetType('TalkAgent')
    $flags = [Reflection.BindingFlags]'NonPublic,Static'
    $generation = [guid]::NewGuid().ToString('D')
    $agent.GetField('root',$flags).SetValue($null,$temporary)
    $agent.GetField('instance',$flags).SetValue($null,$generation)
    function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    function Assert-Ready([string]$method,[bool]$expected) {
        $actual = $agent.GetMethod($method,$flags).Invoke($null,@())
        if ($actual -ne $expected) { throw "$method expected $expected, got $actual" }
    }
    function Publish-Test([string]$path,[string]$instance,[bool]$authenticated) {
        @{instance=$instance;authenticated=$authenticated;updated_at=(Now)} | ConvertTo-Json -Compress | Set-Content -LiteralPath $path -Encoding UTF8
    }
    foreach ($case in @(
        @{method='ParentAlive';file='status.json';field='parentUpdated';expiry=4000},
        @{method='ProviderReady';file='provider.json';field='providerUpdated';expiry=601000}
    )) {
        $path = Join-Path $temporary $case.file
        Publish-Test $path $generation $true
        Assert-Ready $case.method $true
        # Reproduce a transient sharing failure while replacing shared IPC files.
        $locked = [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try {
            Assert-Ready $case.method $true
            $agent.GetField($case.field,$flags).SetValue($null,[long]((Now) - $case.expiry))
            Assert-Ready $case.method $false
        } finally { $locked.Dispose() }
        Publish-Test $path $generation $false
        Assert-Ready $case.method $false
        Publish-Test $path ([guid]::NewGuid().ToString('D')) $true
        Assert-Ready $case.method $false
        Publish-Test $path $generation $true
        Assert-Ready $case.method $true
    }
    Write-Output 'PASS: shared-file contention, expiry, account revocation and generation changes'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
