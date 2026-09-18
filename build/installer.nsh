!include "LogicLib.nsh"

!macro customInstall
  DetailPrint "Verificando o mecanismo OpenVPN e os drivers de rede..."
  File /oname=$PLUGINSDIR\openvpn-stable-amd64.msi "${BUILD_RESOURCES_DIR}\openvpn-stable-amd64.msi"
  File /oname=$PLUGINSDIR\install-openvpn.ps1 "${BUILD_RESOURCES_DIR}\install-openvpn.ps1"
  ExecWait '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-openvpn.ps1" -MsiPath "$PLUGINSDIR\openvpn-stable-amd64.msi"' $0
  ${If} $0 != 0
  ${AndIf} $0 != 3010
    MessageBox MB_ICONSTOP "Não foi possível instalar o componente OpenVPN (código $0). A instalação será cancelada."
    Abort
  ${EndIf}
!macroend
