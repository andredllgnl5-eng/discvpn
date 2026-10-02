const $ = id => document.getElementById(id);
let stream = null, peer = null, audioContext = null, meterTimer = null, signalTimer = null;
let generation = 0;
const calls = new Set();
const quality = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } };
function countViewers() {
  const count = [...calls].filter(call => call.peerConnection?.connectionState === 'connected').length;
  $('viewers').textContent = `${count} espectador${count === 1 ? '' : 'es'}`;
}
function stop(message = 'Transmissão encerrada.') {
  generation++;
  clearInterval(meterTimer); clearTimeout(signalTimer);
  for (const call of calls) call.close();
  calls.clear();
  peer?.destroy(); peer = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  audioContext?.close().catch(() => {}); audioContext = null;
  $('video').srcObject = null;
  $('link').value = ''; $('link-area').classList.add('hidden');
  $('start').disabled = false; $('stop').disabled = true;
  $('audio-level').value = 0; $('audio-status').textContent = 'Áudio aguardando captura';
  $('status').textContent = message;
  countViewers();
  window.screenShare?.active(false).catch(() => {});
}
function monitorAudio(current) {
  const analyser = audioContext.createAnalyser(); analyser.fftSize = 512;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let lastSound = Date.now();
  meterTimer = setInterval(() => {
    if (current !== generation) return;
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    $('audio-level').value = Math.min(1, rms * 5);
    if (rms > 0.002) lastSound = Date.now();
    $('audio-status').textContent = Date.now() - lastSound > 4000 ? 'Áudio conectado — aguardando som do computador' : 'Som do computador sendo capturado';
  }, 150);
}
async function tune(call) {
  try {
    for (const sender of call.peerConnection?.getSenders() || []) {
      if (sender.track?.kind !== 'video') continue;
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = 2500000;
      parameters.encodings[0].maxFramerate = 30;
      parameters.degradationPreference = 'balanced';
      await sender.setParameters(parameters);
    }
  } catch (error) { console.warn('Qualidade:', error.message); }
}
async function start() {
  if (!navigator.mediaDevices?.getDisplayMedia || typeof Peer !== 'function') {
    $('status').textContent = 'A captura não está disponível. Use o Screen Share para Windows ou Chrome/Edge atualizado.'; return;
  }
  const current = ++generation;
  $('start').disabled = true;
  $('status').textContent = 'Escolha a tela que deseja transmitir com som…';
  // Start the audio context and browser picker within the click gesture.
  audioContext = new AudioContext();
  audioContext.resume().catch(() => {});
  try {
    if (window.screenShare) {
      const source = await window.chooseScreenSource();
      if (!source) { stop('Compartilhamento cancelado.'); return; }
      await window.screenShare.selectSource(source);
    }
    const captured = await navigator.mediaDevices.getDisplayMedia({ video: quality,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, systemAudio: 'include', surfaceSwitching: 'exclude' });
    if (current !== generation) { captured.getTracks().forEach(track => track.stop()); return; }
    stream = captured;
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks().find(track => track.readyState === 'live' && track.enabled);
    if (!videoTrack) throw new Error('Nenhuma imagem foi capturada. Escolha a tela novamente.');
    if (!audioTrack) throw new Error('O áudio é obrigatório. Escolha uma aba ou tela inteira e marque “Compartilhar áudio”. No Windows, use o aplicativo Screen Share para incluir o som automaticamente.');
    videoTrack.contentHint = 'motion'; audioTrack.contentHint = 'music';
    videoTrack.addEventListener('ended', () => { if (current === generation) stop(); }, { once: true });
    audioTrack.addEventListener('ended', () => { if (current === generation) stop('O áudio foi interrompido. Escolha a tela novamente para transmitir com som.'); }, { once: true });
    $('video').srcObject = stream; $('video').play().catch(() => {});
    $('stop').disabled = false;
    window.screenShare?.active(true).catch(() => {});
    monitorAudio(current);
    $('status').textContent = 'Preparando o link da transmissão…';
    const network = await ScreenShareNetwork.options();
    if (current !== generation) return;
    peer = new Peer(`shivi-${crypto.randomUUID()}`, network.peer);
    const hostPeer = peer;
    signalTimer = setTimeout(() => { if (current === generation) stop('Não foi possível obter o link. Verifique a internet e tente novamente.'); }, 20000);
    peer.on('open', id => {
      if (current !== generation) return;
      clearTimeout(signalTimer);
      const base = window.screenShare ? ScreenShareNetwork.publicBase : new URL('./', location.href).href;
      $('link').value = `${base}?watch=${encodeURIComponent(id)}`;
      $('link-area').classList.remove('hidden');
      $('status').textContent = 'Ao vivo com áudio — copie o link e envie para quem vai assistir.';
    });
    peer.on('call', call => {
      if (current !== generation || !stream || videoTrack.readyState !== 'live' || audioTrack.readyState !== 'live') { call.close(); return; }
      // Retrying viewers replace their previous call rather than accumulating encoders.
      for (const old of calls) if (old.peer === call.peer) old.close();
      calls.add(call);
      call.on('close', () => { calls.delete(call); countViewers(); });
      call.on('error', () => { calls.delete(call); countViewers(); });
      call.answer(stream);
      call.peerConnection?.addEventListener('connectionstatechange', () => {
        countViewers();
        if (call.peerConnection.connectionState === 'connected') tune(call);
        if (call.peerConnection.connectionState === 'failed') { call.close(); calls.delete(call); countViewers(); }
      });
    });
    peer.on('disconnected', () => {
      if (current !== generation) return;
      $('status').textContent = 'Reconectando o link. A transmissão em andamento pode continuar…';
      hostPeer.reconnect();
      clearTimeout(signalTimer);
      signalTimer = setTimeout(() => { if (current === generation && hostPeer.disconnected) stop('A conexão caiu. Inicie novamente para gerar outro link.'); }, 20000);
    });
    peer.on('error', error => {
      if (current !== generation) return;
      if (error.type === 'peer-unavailable') return;
      stop(`Não foi possível manter a transmissão: ${error.message}`);
    });
  } catch (error) {
    if (current !== generation) return;
    stop(error.name === 'NotAllowedError' ? 'Captura cancelada ou sem permissão. Escolha novamente uma tela com áudio.' : error.message);
  }
}
$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => stop());
$('copy').addEventListener('click', async () => {
  try {
    if (window.screenShare) await window.screenShare.copyLink($('link').value);
    else await navigator.clipboard.writeText($('link').value);
    $('copy').textContent = 'Copiado!';
    setTimeout(() => { $('copy').textContent = 'Copiar link'; }, 1500);
  } catch { $('link').select(); $('status').textContent = 'Selecione o link e pressione Ctrl+C para copiar.'; }
});
window.addEventListener('beforeunload', () => stop());
