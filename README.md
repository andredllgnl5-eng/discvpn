# Screen Share

Aplicativo Windows para transmitir uma tela ou janela com o som do computador e compartilhar um link. A interface e o mecanismo de VPN foram removidos na versão 5.0.0.

## Uso

1. Abra Screen Share e clique em **Escolher tela e transmitir**.
2. Escolha a tela ou janela. O áudio de saída do Windows é incluído automaticamente, inclusive sons de outros aplicativos.
3. Copie o link e mantenha o programa aberto.
4. Quem recebe abre o link e clica em **Assistir com som**. O clique atende à política de reprodução de áudio do navegador.

Uma captura sem faixa de áudio não gera link. O medidor mostra se há som chegando; silêncio na fonte continua sendo silêncio. Encerrar o aplicativo ou a captura encerra a transmissão. Cada início gera um link novo.

O compartilhamento alternativo no navegador, em `docs/share.html`, exige marcar **Compartilhar áudio**. A disponibilidade de áudio de janelas depende do navegador; no Windows, prefira o aplicativo.

## Rede

PeerJS sinaliza as chamadas. `docs/network.json` configura os servidores STUN/TURN usados por transmissor e espectadores. A versão 5.0 usa retransmissão TURN por TLS na porta 443, pois a negociação mista entre conexão direta e relay falhou no teste entre Electron e Edge. A credencial TURN de cliente é destinada à distribuição ao player; não é uma chave administrativa. A transmissão consome a franquia do serviço Metered. Gerencie limites e revogação no painel da conta.

O aplicativo busca essa configuração pública a cada transmissão. Um `iceEndpoint` HTTPS pode substituir a configuração fixa e devolver uma lista `iceServers` com credenciais temporárias. Nunca coloque a chave de gerenciamento da conta no repositório.

## Desenvolvimento e verificação

- `npm ci` e `node node_modules/electron/install.js`
- `npm start`
- `node tests/browser-stream-smoke.js`: bloqueio de captura sem áudio, dois espectadores, vídeo decodificado, energia de áudio recebida e interrupção da faixa de áudio.
- `FORCE_RELAY=1`: força o caminho TURN nos testes; `TLS_ONLY=1` limita o teste ao TURN TLS.
- `node tests/native-stream-smoke.js`: captura de janela e loopback real do Windows, com vídeo e energia de áudio recebidos por um player via TURN. Produz um tom curto para verificar o áudio.
- `npm run build`: instalador Windows.

Testes usam uma fonte visual e um tom controlados. Resultados em uma máquina não garantem todas as redes, drivers, fontes com DRM ou dispositivos de som.

## Publicação e atualização

O repositório continua `andredllgnl5-eng/discvpn` para manter os links e o canal de atualização existentes. O appId legado foi mantido para permitir atualizar instalações antigas. O executável e os atalhos se chamam **Screen Share**. O programa roda sem elevação e o instalador não instala OpenVPN.

A publicação de uma tag `v*` aciona `.github/workflows/release.yml`. A pasta `docs` é publicada pelo GitHub Pages. Atualizar a página pública não atualiza o código que um transmissor já tem aberto: ele precisa recarregar a página ou instalar o novo aplicativo e gerar outro link.
