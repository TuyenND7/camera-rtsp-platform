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
    foreach ($duration in @(0,10,15,30,60)) { $command.duration_seconds=$duration; Assert-Command $true }
    foreach ($duration in @(-1,1,59,61,999,'30',$false,$null)) { $command.duration_seconds=$duration; Assert-Command $false }
    $requestId = Split-Path $requestDirectory -Leaf
    $alarmLease = @{camera_id=2;url_hash=('a' * 64);request=$requestId;agent_instance=$generation;created_at=(Now);duration_seconds=0;ends_at=$null}
    $pulse = @{camera_id=2;request=$requestId;agent_instance=$generation;updated_at=(Now)}
    $workerType=$agent.GetNestedType('WorkerProcess',[Reflection.BindingFlags]'NonPublic')
    $worker=[Activator]::CreateInstance($workerType,$true)
    $workerType.GetField('Directory').SetValue($worker,$requestDirectory)
    $workerType.GetField('Control').SetValue($worker,$true)
    $workerType.GetField('Started').SetValue($worker,[long]((Now)-90000))
    function Assert-AlarmLease([bool]$healthy) {
        $alarmLease | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $temporary 'controls\alarm-2.json') -Encoding UTF8
        $pulse | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $requestDirectory 'heartbeat.json') -Encoding UTF8
        $actual=$agent.GetMethod('ControlLeaseHealthy',$flags).Invoke($null,[object[]]@(([string]$requestDirectory).ToString()))
        $expired=$agent.GetMethod('WorkerExpired',$flags).Invoke($null,[object[]]@($worker.PSObject.BaseObject))
        if ($actual -ne $healthy -or $expired -eq $healthy) { throw 'Alarm duration/heartbeat watchdog failed' }
    }
    Assert-AlarmLease $true
    $alarmLease.duration_seconds=60; $alarmLease.ends_at=(Now)+60000; Assert-AlarmLease $true
    $alarmLease.ends_at=(Now)-6000; Assert-AlarmLease $false
    $alarmLease.duration_seconds=0; $alarmLease.ends_at=$null; $pulse.updated_at=(Now)-6000; Assert-AlarmLease $false
    $pulse.updated_at=Now; $pulse.agent_instance=[guid]::NewGuid().ToString('D'); Assert-AlarmLease $false
    $pulse.agent_instance=$generation; $alarmLease.url_hash=('b' * 64); Assert-AlarmLease $false
    $alarmLease.url_hash=('a' * 64); Assert-AlarmLease $true
    New-Item -ItemType File -Path (Join-Path $requestDirectory 'stop') | Out-Null
    Assert-AlarmLease $false
    Remove-Item -LiteralPath (Join-Path $requestDirectory 'stop')
    $workerType.GetField('Control').SetValue($worker,$false)
    if (-not $agent.GetMethod('WorkerExpired',$flags).Invoke($null,[object[]]@($worker.PSObject.BaseObject))) { throw 'Voice worker lifetime was extended' }
    Write-Output 'PASS: timed/manual alarms, typed durations, heartbeat expiry, stop and voice lifetime isolation'
    $settingsProperties = $serializer.DeserializeObject('{"TurnLight":{"value":0},"ImageFlipState":{"value":0},"stNightVisionMode":{"value":{"enFillLightMode":3,"bMenuLight":1,"s32LightVal":50}},"AudibleAlarm":{"value":{"AlarmSwitch":0,"LightSwitch":1}},"StorageRecordMode":{"value":1},"StorageStatus":{"value":0},"WifiConfiguration":{"value":{"password":"fixture-secret"}}}')
    $snapshot = $agent.GetMethod('SettingsFromProperties',$flags).Invoke($null,@($settingsProperties))
    if ($snapshot.values['image_flip'] -ne 0 -or $snapshot.values['night_vision'] -ne 3 -or $snapshot.values.ContainsKey('WifiConfiguration')) { throw 'Settings whitelist failed' }
    if (($snapshot | ConvertTo-Json -Depth 8 -Compress) -match 'fixture-secret|WifiConfiguration') { throw 'Settings leaked credentials' }
    $settingsCommand = $serializer.DeserializeObject(('{"revision":"' + $snapshot.revision + '","changes":{"night_vision":2,"alarm_sound":1,"flash_light":0}}'))
    $patch = $agent.GetMethod('SettingsPatch',$flags).Invoke($null,[object[]]@($settingsProperties,$settingsCommand))
    if ($patch['TurnLight'] -ne 0) { throw 'Flash-off setting failed' }
    if ($patch['stNightVisionMode']['enFillLightMode'] -ne 2 -or $patch['stNightVisionMode']['bMenuLight'] -ne 1 -or $patch['stNightVisionMode']['s32LightVal'] -ne 50) { throw 'Night vision struct fields were lost' }
    if ($patch['AudibleAlarm']['AlarmSwitch'] -ne 1 -or $patch['AudibleAlarm']['LightSwitch'] -ne 1 -or $settingsProperties['AudibleAlarm']['value']['AlarmSwitch'] -ne 0) { throw 'Nested alarm update failed' }
    function Assert-SettingsRejected([string]$body) {
        $rejected=$false
        try { $null=$agent.GetMethod('SettingsPatch',$flags).Invoke($null,[object[]]@($settingsProperties,$serializer.DeserializeObject($body))) } catch { $rejected=$true }
        if (-not $rejected) { throw 'Unsafe settings command was accepted' }
    }
    Assert-SettingsRejected ('{"revision":"' + ('0' * 64) + '","changes":{"image_flip":1}}')
    Assert-SettingsRejected ('{"revision":"' + $snapshot.revision + '","changes":{"WifiConfiguration":1}}')
    Assert-SettingsRejected ('{"revision":"' + $snapshot.revision + '","changes":{"image_flip":true}}')
    Assert-SettingsRejected ('{"revision":"' + $snapshot.revision + '","changes":{"night_vision":99}}')
    Assert-SettingsRejected ('{"revision":"' + $snapshot.revision + '","changes":{"sd_recording":2}}')
    Assert-SettingsRejected ('{"revision":"' + $snapshot.revision + '","changes":{"speaker_volume":50}}')
    Write-Output 'PASS: device settings privacy, stale revisions, nested field preservation and capability validation'
    Write-Output 'PASS: IPC contention/expiry/revocation, safe control state and bound command validation'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
