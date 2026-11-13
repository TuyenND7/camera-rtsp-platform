$ErrorActionPreference = 'Stop'
$delay = 30
while (-not (Test-Path -LiteralPath "$PSScriptRoot\stop-agent")) {
    $started = Get-Date
    $process = Start-Process -FilePath "$PSScriptRoot\CameraTalkSdk.exe" -ArgumentList "`"$PSScriptRoot\config.bin`"" -WorkingDirectory $PSScriptRoot -RedirectStandardError "$PSScriptRoot\agent.log" -RedirectStandardOutput "$PSScriptRoot\output.log" -PassThru
    $process.WaitForExit()
    if (Test-Path -LiteralPath "$PSScriptRoot\stop-agent") { break }
    if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 30 }
    Start-Sleep -Seconds $delay
    $delay = [Math]::Min(300,$delay * 2)
}
