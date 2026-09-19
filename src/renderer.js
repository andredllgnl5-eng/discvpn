const $ = id => document.getElementById(id);
let state = 'idle';
let selected = '';
let shareStream = null;
let sharePeer = null;
const viewerBase = 'https://andredllgnl5-eng.github.io/discvpn/';
function setState(next, message){state=next;$('status').textContent=message;$('orb').className=`orb ${next}`;$('connect').disabled=next!=='idle'||!selected;$('disconnect').disabled=next==='idle'}
async function loadServers(){
  selected='';$('connect').disabled=true;$('servers').innerHTML='<div class="loading">Medindo servidores canadenses…</div>';
  try{
    const servers=await window.vpn.listServers();
    $('servers').innerHTML=servers.length?'':'<div class="loading">Nenhum servidor disponível agora.</div>';
    for(const server of servers){
      const button=document.createElement('button');button.className='server';button.dataset.id=server.id;
      button.innerHTML=`<div><strong>${server.hostName}</strong><span>${server.ip} · ${server.protocol.toUpperCase()}</span></div><div class="metric"><b>${server.provider||'OpenVPN'}</b>provedor</div><div class="metric"><b>${server.ping&&server.ping<9999?`${server.ping} ms`:'automático'}</b>latência</div><div class="metric"><b>CA</b>região</div>`;
      button.onclick=async()=>{await window.vpn.selectServer(server.id);selected=server.id;document.querySelectorAll('.server').forEach(x=>x.classList.toggle('selected',x.dataset.id===selected));$('connect').disabled=false};
      $('servers').appendChild(button);
    }
  }catch(e){$('servers').innerHTML=`<div class="loading">Falha ao carregar: ${e.message}</div>`}
}
async function refresh(){const i=await window.vpn.info();$('discord').textContent=i.discord?'Encontrado':'Não encontrado';$('discord').className=i.discord?'ok':'';$('openvpn').textContent=i.openVpn?'Pronto':'Será preparado ao conectar';$('openvpn').className='ok';setState('idle','Desconectado');await loadServers()}
$('refresh').onclick=loadServers;
$('connect').onclick=async()=>{try{await window.vpn.connect({fullTunnel:false})}catch(e){setState('idle',e.message||'Não foi possível conectar');$('log').textContent+=`\n${e.message}`;$('log').closest('details').open=true}};
$('disconnect').onclick=()=>window.vpn.disconnect();
window.vpn.onState(x=>setState(x.state,x.message));
window.vpn.onLog(x=>{$('log').textContent+=`\n${x}`;$('log').scrollTop=$('log').scrollHeight});
window.vpn.onStats(x=>$('routes').textContent=x.fullTunnel?'Todo o tráfego protegido':`${x.routes} rotas protegidas`);
async function showSources(){
  $('source-modal').classList.remove('hidden');$('source-grid').innerHTML='<div class="loading">Carregando telas e janelas…</div>';
  try{
    const sources=await window.vpn.captureSources();$('source-grid').innerHTML='';
    for(const source of sources){const button=document.createElement('button');button.className='source';button.innerHTML=`<img src="${source.thumbnail}" alt=""><span>${source.name}</span>`;button.onclick=()=>startShare(source.id);$('source-grid').appendChild(button)}
  }catch(error){$('source-grid').innerHTML=`<div class="loading">Falha ao listar telas: ${error.message}</div>`}
}
async function capture720p60(sourceId){
  const video={mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:sourceId,minWidth:1280,maxWidth:1280,minHeight:720,maxHeight:720,minFrameRate:60,maxFrameRate:60}};
  try{return await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:sourceId}},video})}catch{return navigator.mediaDevices.getUserMedia({audio:false,video})}
}
function tuneCall(call){
  setTimeout(async()=>{try{const senders=call.peerConnection?.getSenders?.()||[];for(const sender of senders){if(sender.track?.kind!=='video')continue;const parameters=sender.getParameters();parameters.encodings=parameters.encodings?.length?parameters.encodings:[{}];parameters.encodings[0].maxBitrate=6000000;parameters.encodings[0].maxFramerate=60;parameters.encodings[0].scaleResolutionDownBy=1;parameters.degradationPreference='maintain-framerate';await sender.setParameters(parameters)}}catch(error){console.warn('Ajuste WebRTC',error)}},600)
}
function stopShare(){
  shareStream?.getTracks().forEach(track=>track.stop());shareStream=null;sharePeer?.destroy();sharePeer=null;$('share-live').classList.add('hidden');$('share-screen').disabled=false;$('share-state').textContent='Transmissão encerrada';
}
async function startShare(sourceId){
  $('source-modal').classList.add('hidden');stopShare();$('share-screen').disabled=true;$('share-live').classList.remove('hidden');$('share-state').textContent='Capturando em 720p 60 FPS…';
  try{
    shareStream=await capture720p60(sourceId);const track=shareStream.getVideoTracks()[0];if(track){track.contentHint='motion';track.addEventListener('ended',stopShare,{once:true})}
    const id=`shivi-${crypto.randomUUID()}`;sharePeer=new Peer(id,{secure:true});
    sharePeer.on('open',peerId=>{const link=`${viewerBase}?watch=${encodeURIComponent(peerId)}`;$('share-link').value=link;$('share-state').textContent='Ao vivo — 1280×720 • 60 FPS • até 6 Mbps'});
    sharePeer.on('call',call=>{call.answer(shareStream);tuneCall(call)});sharePeer.on('error',error=>$('share-state').textContent=`Erro de transmissão: ${error.message}`);
  }catch(error){stopShare();alert(`Não foi possível iniciar a captura: ${error.message}`)}
}
$('share-screen').onclick=showSources;$('close-sources').onclick=()=>$('source-modal').classList.add('hidden');$('stop-share').onclick=stopShare;
$('copy-link').onclick=async()=>{await window.vpn.copyText($('share-link').value);$('copy-link').textContent='Copiado!';setTimeout(()=>$('copy-link').textContent='Copiar link',1500)};
refresh();
