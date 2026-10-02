const $ = id => document.getElementById(id);
const video = $('video');
const host = new URLSearchParams(location.search).get('watch');
let peer, call, requestStream, requestAudio, watchdog, statsTimer, reconnectTimer;
let generation = 0, retries = 0, incoming = false, lastBytes = 0, lastData = 0;
function cleanup() {
  clearTimeout(watchdog); clearTimeout(reconnectTimer); clearInterval(statsTimer);
  call?.close(); call = null; peer?.destroy(); peer = null;
  requestStream?.getTracks().forEach(track => track.stop()); requestStream = null;
  requestAudio?.close().catch(() => {}); requestAudio = null;
  video.srcObject?.getTracks().forEach(track => track.stop()); video.srcObject = null;
}
function failure(message, current, retryable = true) {
  if (current !== generation) return;
  generation++;
  cleanup();
  $('audio').disabled = true; $('fullscreen').disabled = true;
  $('audio-hint').textContent = 'Aguardando uma transmissão com imagem e áudio.';
  if (retryable && retries < 1) {
    retries++;
    $('status').textContent = `${message} Reconectando…`;
    reconnectTimer = setTimeout(connect, 1000);
  } else {
    $('status').textContent = message;
    $('retry').classList.remove('hidden');
  }
}
function updateAudio(stream) {
  const hasAudio = stream.getAudioTracks().some(track => track.readyState === 'live');
  $('audio').disabled = !hasAudio || !incoming;
  $('audio-hint').textContent = hasAudio
    ? 'Clique em “Assistir com som” para liberar o áudio no navegador.'
    : 'Esta transmissão não enviou áudio. Peça ao transmissor para usar a nova versão do Screen Share e gerar outro link.';
}
$('audio').onclick = async () => {
  video.muted = false; if (video.volume === 0) video.volume = 1;
  try { await video.play(); $('audio').textContent = 'Som ativado'; $('audio-hint').textContent = 'Áudio ligado. Ajuste o volume nos controles do vídeo.'; }
  catch { $('status').textContent = 'O navegador bloqueou a reprodução. Clique novamente em “Assistir com som”.'; }
};
video.addEventListener('volumechange', () => { $('audio').textContent = video.muted || video.volume === 0 ? 'Ativar som' : video.paused ? 'Assistir com som' : 'Som ativado'; });
video.addEventListener('playing', () => { $('status').textContent = 'Ao vivo — imagem e áudio conectados'; });
$('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await video.requestFullscreen(); }
  catch { $('status').textContent = 'Use o controle de tela cheia do vídeo.'; }
};
$('retry').onclick = () => { retries = 0; connect(); };
async function connect() {
  const current = ++generation;
  cleanup(); incoming = false; lastBytes = 0; lastData = Date.now();
  $('audio').disabled = true; $('audio').textContent = 'Assistir com som'; $('fullscreen').disabled = true;
  $('retry').classList.add('hidden'); $('status').textContent = 'Conectando à transmissão…';
  if (typeof Peer !== 'function') { failure('Não foi possível carregar o player. Recarregue a página.', current, false); return; }
  const network = await ScreenShareNetwork.options();
  if (current !== generation) return;
  if (retries > 0 && network.relay) network.peer.config.iceTransportPolicy = 'relay';
  const networkFailure = network.relay ? 'A conexão de vídeo falhou mesmo com retransmissão. Verifique a internet e tente novamente.' : 'A rede bloqueou a conexão direta e o servidor de retransmissão está indisponível.';
  watchdog = setTimeout(() => failure('Nenhum vídeo chegou. Confirme que o transmissor manteve o aplicativo aberto.', current), 30000);
  peer = new Peer(undefined, network.peer);
  peer.on('open', () => {
    if (current !== generation) return;
    $('status').textContent = 'Conectando imagem e áudio…';
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    requestStream = canvas.captureStream(1);
    requestAudio = new AudioContext();
    requestStream.addTrack(requestAudio.createMediaStreamDestination().stream.getAudioTracks()[0]);
    call = peer.call(host, requestStream);
    if (!call) { failure('Não foi possível iniciar a chamada.', current); return; }
    const connection = call.peerConnection;
    call.on('stream', stream => {
      if (current !== generation) return;
      video.srcObject = stream; video.muted = false; updateAudio(stream);
      stream.addEventListener('addtrack', () => updateAudio(stream));
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
        failure('O áudio da transmissão foi interrompido. Peça um novo link ao transmissor.', current, false);
      }));
    });
    statsTimer = setInterval(async () => {
      try {
        const stats = await connection.getStats();
        if (current !== generation) return;
        let bytes = 0;
        stats.forEach(report => { if (report.type === 'inbound-rtp' && report.kind === 'video') bytes += report.bytesReceived || 0; });
        if (bytes > lastBytes) {
          lastData = Date.now();
          if (!incoming) {
            incoming = true; clearTimeout(watchdog); $('fullscreen').disabled = false;
            $('status').textContent = 'Transmissão pronta — clique em “Assistir com som”.';
            if (video.srcObject) updateAudio(video.srcObject);
          }
        } else if (incoming && Date.now() - lastData > 20000) failure('A transmissão parou de enviar vídeo.', current);
        lastBytes = bytes;
      } catch { /* Closing a peer connection invalidates pending stats. */ }
    }, 1000);
    call.on('close', () => failure('A transmissão foi encerrada. Peça um novo link se ela foi reiniciada.', current, false));
    call.on('error', () => failure(networkFailure, current));
    connection.addEventListener('connectionstatechange', () => {
      if (current !== generation) return;
      if (connection.connectionState === 'failed') failure(networkFailure, current);
      if (connection.connectionState === 'disconnected') $('status').textContent = 'A conexão oscilou. Tentando recuperar…';
      if (connection.connectionState === 'connected' && incoming) $('status').textContent = video.paused ? 'Transmissão pronta — clique em “Assistir com som”.' : 'Ao vivo — imagem e áudio conectados';
    });
  });
  peer.on('error', error => failure(error.type === 'peer-unavailable'
    ? 'Este link está offline ou expirou. Peça ao seu amigo para iniciar a transmissão e enviar um novo link.'
    : `Falha ao conectar: ${error.message}`, current, error.type !== 'peer-unavailable'));
}
window.addEventListener('beforeunload', () => { generation++; cleanup(); });
if (!host || !/^shivi-[a-zA-Z0-9-]+$/.test(host)) $('status').textContent = 'Abra o link enviado por quem está transmitindo.';
else connect();
