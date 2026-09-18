# North America Discord VPN

Aplicativo Electron para abrir o Discord usando servidores OpenVPN nos Estados Unidos ou Canadá.

## Requisitos

- Windows 10/11
- Discord desktop
- Acesso à internet para obter os perfis e a credencial atual do VPNBook

## Como funciona

O aplicativo consulta os servidores públicos do VPNBook, baixa automaticamente o perfil escolhido e obtém a credencial rotativa atual. O instalador oficial e assinado do OpenVPN está incorporado ao instalador e prepara silenciosamente o mecanismo e o driver de rede. Não é preciso baixar o OpenVPN, inserir senha nem selecionar arquivos `.ovpn`.

O aplicativo primeiro confirma o túnel norte-americano, depois encerra e reabre o Discord. Por padrão somente os endereços conhecidos do Discord usam a VPN, enquanto jogos e outros aplicativos permanecem na conexão normal. O modo opcional de compatibilidade encaminha todo o tráfego pela VPN quando necessário para contornar o erro 2012 de transmissão.

Isso reduz o impacto sobre outros aplicativos, mas não pode garantir ping inalterado no próprio Discord. A região de mídia e a disponibilidade do compartilhamento de tela também dependem dos servidores e políticas do Discord.

## Atualizações automáticas pelo GitHub

O aplicativo usa o repositório `andredllgnl5-eng/discvpn`. O instalador consulta o arquivo `latest.yml` de cada GitHub Release, baixa novas versões em segundo plano e instala a atualização ao fechar o aplicativo.

Para publicar manualmente, defina `GH_TOKEN` localmente e execute `npm run publish`. Nunca inclua o token no código ou no instalador.

O workflow em `.github/workflows/release.yml` também publica automaticamente quando uma tag `v*` é enviada ao GitHub.
