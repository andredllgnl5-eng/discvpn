window.ScreenShareNetwork = (() => {
  const publicBase = 'https://andredllgnl5-eng.github.io/discvpn/';
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
  async function options() {
    let iceServers = fallback;
    let policy = 'all';
    try {
      const url = window.screenShare ? `${publicBase}network.json` : new URL('network.json', location.href);
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error('Configuração indisponível.');
      const config = await response.json();
      let servers = config.iceServers;
      if (config.iceEndpoint) {
        if (new URL(config.iceEndpoint).protocol !== 'https:') throw new Error('Endpoint inválido.');
        const credentials = await fetch(config.iceEndpoint, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
        if (!credentials.ok) throw new Error('Servidor de retransmissão indisponível.');
        const payload = await credentials.json();
        servers = Array.isArray(payload) ? payload : payload.iceServers;
      }
      if (!Array.isArray(servers) || !servers.length || !servers.every(server =>
        [server.urls].flat().every(url => typeof url === 'string' && /^(stun|stuns|turn|turns):/.test(url)))) throw new Error('Configuração ICE inválida.');
      iceServers = servers;
      if (config.iceTransportPolicy === 'relay') policy = 'relay';
    } catch (error) { console.warn('Rede: usando conexão direta.', error.message); }
    const relay = iceServers.some(server => [server.urls].flat().some(url => /^turns?:/.test(url)));
    return { peer: { secure: true, config: { iceServers, iceTransportPolicy: relay ? policy : 'all' } }, relay };
  }
  return { options, publicBase };
})();
