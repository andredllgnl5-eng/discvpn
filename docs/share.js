const $ = id => document.getElementById(id);
let stream = null;
let peer = null;
const calls = new Set();
const quality = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } };

function stop() {
  for (const call of calls) call.close();
  calls.clear();
  peer?.destroy(); peer = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  $('video').srcObject = null;
  $('link').value = '';
  $('link-area').classList.add('hidden');
  $('start').disabled = false;
  $('stop').disabled = true;
  $('status').textContent = 'Transmissão encerrada.';
}

async function tune(call) {
  await new Promise(resolve => setTimeout(resolve, 300));
  try {
    for (const sender of call.peerConnection?.getSenders() || []) {
      if (sender.track?.kind !== 'video') continue;
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = 3500000;
      parameters.encodings[0].maxFramerate = 60;
      parameters.encodings[0].scaleResolutionDownBy = 1;
      parameters.degradationPreference = 'maintain-resolution';
      await sender.setParameters(parameters);
    }
  } catch (error) { console.warn('Qualidade WebRTC:', error); }
}

async function start() {
  if (!navigator.mediaDevices?.getDisplayMedia || typeof Peer !== 'function') {
    $('status').textContent = 'Abra esta página em Chrome ou Edge atualizado. A captura ou sinalização não está disponível neste navegador.';
    return;
  }
  $('status').textContent = 'Aguardando escolha da tela…';
  $('start').disabled = true;
  try {
    // Must run directly from the click gesture for the browser's native picker.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: quality, audio: true });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('O navegador não forneceu vídeo.');
    track.contentHint = 'motion';
    track.addEventListener('ended', stop, { once: true });
    $('video').srcObject = stream;
    $('stop').disabled = false;
    $('status').textContent = 'Conectando à sinalização…';
    peer = new Peer(`shivi-${crypto.randomUUID()}`, { secure: true });
    peer.on('open', id => {
      $('link').value = new URL(`./?watch=${encodeURIComponent(id)}`, location.href).href;
      $('link-area').classList.remove('hidden');
      const settings = track.getSettings();
      const audioStatus = stream.getAudioTracks().length ? 'Áudio compartilhado.' : 'Sem áudio: marque “Compartilhar áudio” no seletor do navegador, se disponível.';
      $('status').textContent = `Ao vivo — captura ${settings.width}×${settings.height} a até ${settings.frameRate} FPS. ${audioStatus}`;
    });
    peer.on('call', call => {
      if (!stream || !peer || track.readyState !== 'live') { call.close(); return; }
      calls.add(call);
      call.on('close', () => calls.delete(call));
      call.on('error', error => { calls.delete(call); $('status').textContent = `Falha ao enviar vídeo: ${error.message}`; });
      call.answer(stream);
      tune(call);
    });
    peer.on('error', error => { $('status').textContent = `Falha na conexão: ${error.message}`; });
  } catch (error) {
    stop();
    $('status').textContent = error.name === 'NotAllowedError' ? 'Compartilhamento cancelado. Clique para escolher novamente.' : `Falha ao capturar: ${error.message}`;
  }
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('link').value);
  $('copy').textContent = 'Copiado!';
  setTimeout(() => { $('copy').textContent = 'Copiar link'; }, 1500);
});
window.addEventListener('beforeunload', stop);
