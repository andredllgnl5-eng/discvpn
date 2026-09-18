# Japan Discord VPN

Aplicativo Electron para abrir o Discord com rotas dinâmicas via uma conexão OpenVPN japonesa.

## Requisitos

- Windows 10/11
- Discord desktop
- Acesso à internet para obter a lista atual de servidores japoneses

## Como funciona

O aplicativo consulta a lista pública do VPN Gate, filtra servidores japoneses com OpenVPN e permite escolher pelo ping e velocidade. O instalador oficial e assinado do OpenVPN está incorporado ao instalador do Japan Discord VPN e prepara silenciosamente o mecanismo e o driver de rede. Não é preciso baixar o OpenVPN nem selecionar arquivos `.ovpn`.

O aplicativo encerra processos existentes do Discord, estabelece o túnel japonês e só então reabre o cliente. Enquanto conectado, o túnel completo permite que as verificações regionais do Discord vejam o endereço japonês. Isso pode aumentar a latência de outros aplicativos durante a conexão. A disponibilidade do compartilhamento de tela ainda depende das políticas e verificações do Discord.

Isso reduz o impacto sobre outros aplicativos, mas não pode garantir ping inalterado no próprio Discord nem que o Discord classificará a sessão como japonesa. A região de mídia e a disponibilidade de compartilhamento de tela também dependem dos servidores e políticas do Discord.

## Atualizações automáticas pelo GitHub

O aplicativo usa o repositório `andredllgnl5-eng/discvpn`. O instalador consulta o arquivo `latest.yml` de cada GitHub Release, baixa novas versões em segundo plano e instala a atualização ao fechar o aplicativo.

Para publicar manualmente, defina `GH_TOKEN` localmente e execute `npm run publish`. Nunca inclua o token no código ou no instalador.

O workflow em `.github/workflows/release.yml` também publica automaticamente quando uma tag `v*` é enviada ao GitHub.
