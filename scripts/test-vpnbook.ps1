$ErrorActionPreference = 'Stop'
$page = (Invoke-WebRequest -UseBasicParsing -Uri 'https://www.vpnbook.com/freevpn/openvpn' -TimeoutSec 20).Content
$match = [regex]::Match($page, 'Password</label>[\s\S]{0,600}?<code[^>]*>([^<]+)</code>', 'IgnoreCase')
if (-not $match.Success) { throw 'Credencial do VPNBook não encontrada.' }

$testDir = Join-Path $env:TEMP 'north-america-discord-vpn-test'
New-Item -ItemType Directory -Path $testDir -Force | Out-Null
$authPath = Join-Path $testDir 'auth.txt'
$configPath = Join-Path $testDir 'server.ovpn'
$logPath = Join-Path $testDir 'openvpn.log'
[IO.File]::WriteAllText($authPath, "vpnbook`n$($match.Groups[1].Value.Trim())`n")
$configBytes = (Invoke-WebRequest -UseBasicParsing -Uri 'https://www.vpnbook.com/api/openvpn?hostname=us16.vpnbook.com&protocol=udp25000&ip=147.135.15.16' -TimeoutSec 20).Content
$config = if ($configBytes -is [byte[]]) { [Text.Encoding]::UTF8.GetString($configBytes) } else { [string]$configBytes }
$config = [regex]::Replace($config, '(?m)^auth-user-pass.*$', "auth-user-pass `"$($authPath.Replace('\', '\\'))`"")
[IO.File]::WriteAllText($configPath, $config)

$openVpn = 'C:\Program Files\OpenVPN\bin\openvpn.exe'
if (-not (Test-Path -LiteralPath $openVpn)) { throw 'OpenVPN não encontrado.' }
$process = Start-Process -FilePath $openVpn -ArgumentList @('--config', $configPath, '--route-nopull', '--auth-nocache', '--connect-timeout', '8', '--connect-retry-max', '1', '--log', $logPath) -PassThru -WindowStyle Hidden
try {
  $deadline = (Get-Date).AddSeconds(35)
  do {
    Start-Sleep -Milliseconds 500
    $log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { '' }
    if ($log -match 'Initialization Sequence Completed') { Write-Output 'VPNBOOK_TEST_OK'; exit 0 }
    if ($process.HasExited) { throw "OpenVPN finalizou com código $($process.ExitCode).`n$log" }
  } while ((Get-Date) -lt $deadline)
  throw "Tempo esgotado.`n$log"
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}
