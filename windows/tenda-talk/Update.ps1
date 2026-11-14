param([string]$InstallDirectory = "$env:ProgramData\CameraStation\TendaTalk")
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath "$InstallDirectory\config.bin")) { throw 'Install and provision the adapter before updating it.' }
$hashes = Get-Content -LiteralPath "$PSScriptRoot\RuntimeHashes.json" -Raw | ConvertFrom-Json
foreach ($item in $hashes.PSObject.Properties) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $InstallDirectory $item.Name)).Hash.ToLowerInvariant() -ne $item.Value) { throw "SDK runtime version mismatch: $($item.Name)" }
}
# Compile before stopping the working service. Preserve its encrypted account and SDK cache.
$next = Join-Path $InstallDirectory 'CameraTalkSdk.next.exe'
$arguments = @('/nologo','/platform:x64','/r:System.Web.Extensions.dll','/r:System.Security.dll',"/resource:$PSScriptRoot\RuntimeHashes.json,RuntimeHashes.json","/out:$next")
$arguments += @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' | ForEach-Object FullName)
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" @arguments
if ($LASTEXITCODE -ne 0) { throw 'Agent compilation failed; the running service was kept.' }
$agentPath = Join-Path $InstallDirectory 'CameraTalkSdk.exe'
New-Item -ItemType File -Force "$InstallDirectory\stop-agent" | Out-Null
try {
    Start-Sleep -Seconds 2
    Stop-ScheduledTask -TaskName 'Camera Station Tenda Talk'
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        if (@(Get-Process -Name CameraTalkSdk -ErrorAction SilentlyContinue | Where-Object Path -eq $agentPath).Count -eq 0) { break }
        Start-Sleep -Seconds 1
    }
    Get-Process -Name CameraTalkSdk -ErrorAction SilentlyContinue | Where-Object Path -eq $agentPath | Stop-Process -Force
    Copy-Item -LiteralPath $agentPath -Destination "$InstallDirectory\CameraTalkSdk.previous.exe" -Force
    Move-Item -LiteralPath $next -Destination $agentPath -Force
    Copy-Item -LiteralPath "$PSScriptRoot\Run.ps1" -Destination "$InstallDirectory\Run.ps1" -Force
} finally {
    Remove-Item -LiteralPath "$InstallDirectory\stop-agent" -Force -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName 'Camera Station Tenda Talk'
}
Write-Output 'Updated Tenda adapter; encrypted configuration and camera bindings preserved.'
