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
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object Web.Script.Serialization.JavaScriptSerializer
    $properties = $serializer.DeserializeObject('{"FunctionSet":{"value":{"oneKeyAlarm":1}},"AudibleStatus":{"value":0,"time":100},"TurnLight":{"value":1,"time":101},"WifiConfiguration":{"value":{"password":"fixture-private-camera-password"}}}')
    $state = $agent.GetMethod('ControlStateFromProperties',$flags).Invoke($null,@($properties))
    if (-not $state.alarm_supported -or $null -ne $state.alarm_active -or -not $state.light_supported -or $state.light_enabled -ne $true) { throw 'Invalid device control state' }
    if (($state | ConvertTo-Json -Compress) -match 'fixture-private|WifiConfiguration') { throw 'Private camera properties leaked' }
    $unknown = $agent.GetMethod('ControlStateFromProperties',$flags).Invoke($null,@($serializer.DeserializeObject('{}')))
    if ($unknown.alarm_supported -or $unknown.light_supported -or $null -ne $unknown.alarm_active) { throw 'Unknown state must not become supported/off' }
    $bindings = $agent.GetField('bindings',$flags).GetValue($null)
    $binding = New-Object 'Collections.Generic.Dictionary[string,object]'
    $binding.Add('id',2); $binding.Add('model','CT3V1.0'); $binding.Add('url_hash',('a' * 64)); $bindings.Add($binding)
    $requestDirectory = Join-Path $temporary ('controls\' + [guid]::NewGuid().ToString('D'))
    New-Item -ItemType Directory -Path $requestDirectory -Force | Out-Null
    $command = @{version=1;camera_id=2;url_hash=('a' * 64);agent_instance=$generation;created_at=(Now);action='light';enabled=$true}
    function Assert-Command([bool]$valid) {
        $command | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $requestDirectory 'request.json') -Encoding UTF8
        $accepted=$true
        try { $null=$agent.GetMethod('ControlCommand',$flags).Invoke($null,[object[]]@(([string]$requestDirectory).ToString())) } catch { $accepted=$false }
        if ($accepted -ne $valid) { throw 'Control command validation failed' }
    }
    Assert-Command $true
    $command.action='reboot'; Assert-Command $false
    $command.action='light'; $command.url_hash=('b' * 64); Assert-Command $false
    $command.url_hash=('a' * 64); $command.created_at=(Now)-31000; Assert-Command $false
    $command.created_at=Now; $command.agent_instance=[guid]::NewGuid().ToString('D'); Assert-Command $false
    $command.agent_instance=$generation; $command.action='alarm'; $command.duration_seconds=999; Assert-Command $false
    $command.duration_seconds=5; Assert-Command $true
    Write-Output 'PASS: IPC contention/expiry/revocation, safe control state and bound command validation'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
