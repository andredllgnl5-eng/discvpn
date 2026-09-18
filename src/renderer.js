const $ = id => document.getElementById(id);
let state = 'idle';
function setState(next, message){state=next;$('status').textContent=message;$('orb').className=`orb ${next}`;$('connect').disabled=next!=='idle';$('disconnect').disabled=next==='idle'}
async function refresh(){const i=await window.vpn.info();$('discord').textContent=i.discord?'Encontrado':'Não encontrado';$('discord').className=i.discord?'ok':'';$('openvpn').textContent=i.openVpn?'Encontrado':'Não instalado';$('openvpn').className=i.openVpn?'ok':'';$('config').value=i.config||'';setState('idle','Desconectado')}
$('choose').onclick=async()=>{$('config').value=await window.vpn.chooseConfig()};
$('install').onclick=()=>window.vpn.installOpenVpn();
$('connect').onclick=async()=>{try{await window.vpn.connect()}catch(e){setState('idle','Não foi possível conectar');$('log').textContent+=`\n${e.message}`}};
$('disconnect').onclick=()=>window.vpn.disconnect();
window.vpn.onState(x=>setState(x.state,x.message));
window.vpn.onLog(x=>{$('log').textContent+=`\n${x}`;$('log').scrollTop=$('log').scrollHeight});
window.vpn.onStats(x=>$('routes').textContent=`${x.routes} rotas protegidas`);
refresh();
