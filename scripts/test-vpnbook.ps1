param([switch]$FullTunnel)
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
$config = [regex]::Replace($config, '(?im)^redirect-gateway.*$', '')
$config = [regex]::Replace($config, '(?im)^block-outside-dns.*$', '')
$config = [regex]::Replace($config, '(?im)^tun-mtu.*$', '')
$config = [regex]::Replace($config, '(?im)^mssfix.*$', '')
$config = [regex]::Replace($config, '(?m)^auth-user-pass.*$', "auth-user-pass `"$($authPath.Replace('\', '\\'))`"")
$config += "`npull-filter ignore `"redirect-gateway`"`npull-filter ignore `"block-outside-dns`"`ntun-mtu 1400`nmssfix 1360`n"
[IO.File]::WriteAllText($configPath, $config)

$openVpn = 'C:\Program Files\OpenVPN\bin\openvpn.exe'
if (-not (Test-Path -LiteralPath $openVpn)) { throw 'OpenVPN não encontrado.' }
$routeArguments = if ($FullTunnel) { @('--redirect-gateway', 'def1') } else { @('--route-nopull') }
$arguments = @('--config', $configPath, '--auth-nocache', '--disable-dco', '--connect-timeout', '8', '--connect-retry-max', '1', '--log', $logPath) + $routeArguments
$process = Start-Process -FilePath $openVpn -ArgumentList $arguments -PassThru -WindowStyle Hidden
try {
  $deadline = (Get-Date).AddSeconds(35)
  do {
    Start-Sleep -Milliseconds 500
    $log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { '' }
    if ($log -match 'Initialization Sequence Completed') {
      if ($FullTunnel) {
        $pingOutput = & ping.exe -4 -n 5 -w 1200 1.1.1.1
        $replies = @($pingOutput | Select-String 'TTL=').Count
        $publicIp = (Invoke-WebRequest -UseBasicParsing -Uri 'https://api.ipify.org' -TimeoutSec 15).Content
        $discord = Test-NetConnection 'latency.discord.media' -Port 443 -InformationLevel Quiet
        Write-Output "VPNBOOK_FULL_TEST replies=$replies/5 publicIp=$publicIp discord443=$discord"
        if ($replies -lt 4 -or -not $discord) { throw 'Qualidade insuficiente para mídia do Discord.' }
      }
      Write-Output 'VPNBOOK_TEST_OK'
      exit 0
    }
    if ($process.HasExited) { throw "OpenVPN finalizou com código $($process.ExitCode).`n$log" }
  } while ((Get-Date) -lt $deadline)
  throw "Tempo esgotado.`n$log"
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}
