!include "LogicLib.nsh"

!macro customInstall
  ${IfNot} ${FileExists} "$PROGRAMFILES64\OpenVPN\bin\openvpn.exe"
    DetailPrint "Instalando o mecanismo OpenVPN e o driver de rede..."
    File /oname=$PLUGINSDIR\openvpn-stable-amd64.msi "${BUILD_RESOURCES_DIR}\openvpn-stable-amd64.msi"
    ExecWait '"msiexec.exe" /i "$PLUGINSDIR\openvpn-stable-amd64.msi" /qn /norestart' $0
    ${If} $0 != 0
    ${AndIf} $0 != 3010
      MessageBox MB_ICONSTOP "Não foi possível instalar o componente OpenVPN (código $0). A instalação será cancelada."
      Abort
    ${EndIf}
  ${EndIf}
!macroend
