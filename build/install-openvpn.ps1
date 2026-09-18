param([Parameter(Mandatory = $true)][string]$MsiPath)

$ErrorActionPreference = 'Stop'

function Has-OpenVpnAdapter {
  $drivers = (& pnputil.exe /enum-drivers /class Net 2>$null | Out-String)
  return ($drivers -match 'oemvista\.inf' -and $drivers -match 'ovpn-dco\.inf')
}

$openVpnExe = 'C:\Program Files\OpenVPN\bin\openvpn.exe'
if ((Test-Path -LiteralPath $openVpnExe) -and (Has-OpenVpnAdapter)) {
  exit 0
}

if (Test-Path -LiteralPath $openVpnExe) {
  $entries = @(Get-ItemProperty `
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', `
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' `
    -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'OpenVPN 2.*' })
  foreach ($entry in $entries) {
    if ($entry.PSChildName -match '^\{[0-9A-Fa-f-]{36}\}$') {
      $uninstall = Start-Process msiexec.exe -ArgumentList @('/x', $entry.PSChildName, '/qn', '/norestart') -Wait -PassThru -WindowStyle Hidden
      if ($uninstall.ExitCode -ne 0 -and $uninstall.ExitCode -ne 3010) { exit $uninstall.ExitCode }
    }
  }
}

$arguments = @('/i', "`"$MsiPath`"", 'ADDLOCAL=OpenVPN,OpenVPN.Service,Drivers,Drivers.TAPWindows6,Drivers.OvpnDco', '/qn', '/norestart')
$install = Start-Process msiexec.exe -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
if ($install.ExitCode -ne 0 -and $install.ExitCode -ne 3010) { exit $install.ExitCode }
if (-not (Has-OpenVpnAdapter)) { exit 1603 }
exit 0
