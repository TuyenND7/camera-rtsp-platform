param(
    [Parameter(Mandatory=$true)][string]$RuntimeDirectory,
    [Parameter(Mandatory=$true)][string]$ProvisioningFile,
    [string]$StorageAccount,
    [string]$InstallDirectory = "$env:ProgramData\CameraStation\TendaTalk"
)
$ErrorActionPreference = 'Stop'
$sourceDirectory = $PSScriptRoot
$provisioning = Get-Content -LiteralPath $ProvisioningFile -Raw | ConvertFrom-Json
$ipcDirectory = [IO.Path]::GetFullPath($provisioning.ipcDirectory)
if ([IO.Path]::GetFileName($ipcDirectory.TrimEnd('\')) -ne '.tenda-talk') { throw 'IPC directory must end in .tenda-talk' }
New-Item -ItemType Directory -Force -Path $InstallDirectory,$ipcDirectory | Out-Null
foreach ($directory in @($InstallDirectory,$ipcDirectory)) {
    & icacls.exe $directory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot protect the SDK directory' }
}
if (-not $StorageAccount) { $StorageAccount = (Get-Acl -LiteralPath (Split-Path -Parent $ipcDirectory)).Owner }
$storageSid = ([Security.Principal.NTAccount]$StorageAccount).Translate([Security.Principal.SecurityIdentifier]).Value
& icacls.exe $ipcDirectory /grant:r "*$($storageSid):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot grant the Docker storage account access to SDK IPC' }
$hashes = Get-Content -LiteralPath "$sourceDirectory\RuntimeHashes.json" -Raw | ConvertFrom-Json
foreach ($item in $hashes.PSObject.Properties) {
    $path = Join-Path $RuntimeDirectory $item.Name
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne $item.Value) { throw "SDK runtime version mismatch: $($item.Name)" }
}
if (Get-ScheduledTask -TaskName 'Camera Station Tenda Talk' -ErrorAction SilentlyContinue) {
    New-Item -ItemType File -Force "$InstallDirectory\stop-agent" | Out-Null
    Start-Sleep -Seconds 2
    Stop-ScheduledTask -TaskName 'Camera Station Tenda Talk'
}
$agentPath = Join-Path $InstallDirectory 'CameraTalkSdk.exe'
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    $agents = @(Get-Process -Name 'CameraTalkSdk' -ErrorAction SilentlyContinue | Where-Object Path -eq $agentPath)
    if ($agents.Count -eq 0) { break }
    Start-Sleep -Seconds 1
}
# Terminate only this adapter if a vendor worker prevents clean process exit.
Get-Process -Name 'CameraTalkSdk' -ErrorAction SilentlyContinue | Where-Object Path -eq $agentPath | Stop-Process -Force
foreach ($item in $hashes.PSObject.Properties) {
    $destination = Join-Path $InstallDirectory $item.Name
    if (-not (Test-Path -LiteralPath $destination) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant() -ne $item.Value) {
        Copy-Item -LiteralPath (Join-Path $RuntimeDirectory $item.Name) -Destination $InstallDirectory -Force
    }
}
$compiler = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$compileArguments = @('/nologo','/platform:x64','/r:System.Web.Extensions.dll','/r:System.Security.dll',"/resource:$sourceDirectory\RuntimeHashes.json,RuntimeHashes.json","/out:$InstallDirectory\CameraTalkSdk.exe")
$compileArguments += @(Get-ChildItem -LiteralPath $sourceDirectory -Filter '*.cs' | ForEach-Object FullName)
& $compiler @compileArguments
if ($LASTEXITCODE -ne 0) { throw 'SDK agent compilation failed' }
Add-Type -AssemblyName System.Security
$plaintext = [Text.Encoding]::UTF8.GetBytes((Get-Content -LiteralPath $ProvisioningFile -Raw))
$encrypted = [Security.Cryptography.ProtectedData]::Protect($plaintext,[Text.Encoding]::UTF8.GetBytes('CameraStation.TendaTalk.v1'),[Security.Cryptography.DataProtectionScope]::LocalMachine)
[IO.File]::WriteAllBytes("$InstallDirectory\config.bin",$encrypted)
[Array]::Clear($plaintext,0,$plaintext.Length)
Copy-Item -LiteralPath "$sourceDirectory\Run.ps1" -Destination "$InstallDirectory\Run.ps1" -Force
Remove-Item -LiteralPath "$InstallDirectory\stop-agent" -Force -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$InstallDirectory\Run.ps1`"" -WorkingDirectory $InstallDirectory
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName 'Camera Station Tenda Talk' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName 'Camera Station Tenda Talk'
Write-Output 'Installed Camera Station Tenda Talk. Account configuration is protected with Windows DPAPI.'
