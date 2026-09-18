const $ = id => document.getElementById(id);
let state = 'idle';
let selected = '';
function setState(next, message){state=next;$('status').textContent=message;$('orb').className=`orb ${next}`;$('connect').disabled=next!=='idle'||!selected;$('disconnect').disabled=next==='idle'}
async function loadServers(){
  selected='';$('connect').disabled=true;$('servers').innerHTML='<div class="loading">Buscando servidores japoneses…</div>';
  try{
    const servers=await window.vpn.listServers();
    $('servers').innerHTML=servers.length?'':'<div class="loading">Nenhum servidor disponível agora.</div>';
    for(const server of servers){
      const button=document.createElement('button');button.className='server';button.dataset.id=server.id;
      button.innerHTML=`<div><strong>${server.hostName}</strong><span>${server.ip} · ${server.protocol.toUpperCase()}</span></div><div class="metric"><b>${server.ping} ms</b>ping</div><div class="metric"><b>${server.speedMbps} Mbps</b>velocidade</div><div class="metric"><b>${server.sessions}</b>sessões</div>`;
      button.onclick=async()=>{await window.vpn.selectServer(server.id);selected=server.id;document.querySelectorAll('.server').forEach(x=>x.classList.toggle('selected',x.dataset.id===selected));$('connect').disabled=false};
      $('servers').appendChild(button);
    }
  }catch(e){$('servers').innerHTML=`<div class="loading">Falha ao carregar: ${e.message}</div>`}
}
async function refresh(){const i=await window.vpn.info();$('discord').textContent=i.discord?'Encontrado':'Não encontrado';$('discord').className=i.discord?'ok':'';$('openvpn').textContent=i.openVpn?'Pronto':'Será preparado ao conectar';$('openvpn').className='ok';setState('idle','Desconectado');await loadServers()}
$('refresh').onclick=loadServers;
$('connect').onclick=async()=>{try{await window.vpn.connect()}catch(e){setState('idle',e.message||'Não foi possível conectar');$('log').textContent+=`\n${e.message}`;$('log').closest('details').open=true}};
$('disconnect').onclick=()=>window.vpn.disconnect();
window.vpn.onState(x=>setState(x.state,x.message));
window.vpn.onLog(x=>{$('log').textContent+=`\n${x}`;$('log').scrollTop=$('log').scrollHeight});
window.vpn.onStats(x=>$('routes').textContent=`${x.routes} rotas protegidas`);
refresh();
