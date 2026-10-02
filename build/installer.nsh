; Keep the legacy appId so existing installations receive Screen Share updates.
; Remove the old shortcuts only; no network components are installed or changed.
!macro customInstall
  Delete "$DESKTOP\Canada Discord VPN.lnk"
  Delete "$SMPROGRAMS\Canada Discord VPN.lnk"
  Delete "$DESKTOP\Japan Discord VPN.lnk"
  Delete "$SMPROGRAMS\Japan Discord VPN.lnk"
!macroend
