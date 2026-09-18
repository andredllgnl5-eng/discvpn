# Japan Discord VPN

Aplicativo Electron para abrir o Discord com rotas dinâmicas via uma conexão OpenVPN japonesa.

## Requisitos

- Windows 10/11
- Discord desktop
- OpenVPN Community
- Um perfil `.ovpn` válido de um servidor localizado no Japão

## Como funciona

O OpenVPN inicia com `route-nopull`, portanto não substitui a rota padrão do Windows. Depois que o Discord abre, o aplicativo observa os IPs remotos usados pelos processos do Discord e adiciona rotas `/32` pela interface OpenVPN. Ao desconectar, as rotas são removidas.

Isso reduz o impacto sobre outros aplicativos, mas não pode garantir ping inalterado no próprio Discord nem que o Discord classificará a sessão como japonesa. A região de mídia e a disponibilidade de compartilhamento de tela também dependem dos servidores e políticas do Discord.

## Atualizações automáticas pelo GitHub

O aplicativo usa o repositório `andredllgnl5-eng/discvpn`. O instalador consulta o arquivo `latest.yml` de cada GitHub Release, baixa novas versões em segundo plano e instala a atualização ao fechar o aplicativo.

Para publicar manualmente, defina `GH_TOKEN` localmente e execute `npm run publish`. Nunca inclua o token no código ou no instalador.

O workflow em `.github/workflows/release.yml` também publica automaticamente quando uma tag `v*` é enviada ao GitHub.
