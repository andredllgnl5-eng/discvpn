window.chooseScreenSource = async () => {
  const picker = document.getElementById('source-picker');
  const list = document.getElementById('sources');
  list.textContent = 'Carregando telas e janelas…';
  picker.showModal();
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (id, error) => {
      if (finished) return;
      finished = true;
      picker.close();
      picker.removeEventListener('cancel', cancel);
      document.getElementById('cancel-source').onclick = null;
      if (error) reject(error); else resolve(id);
    };
    const cancel = event => { event?.preventDefault(); finish(null); };
    picker.addEventListener('cancel', cancel);
    document.getElementById('cancel-source').onclick = cancel;
    window.screenShare.sources().then(sources => {
      if (finished) return;
      list.textContent = sources.length ? '' : 'Nenhuma tela ou janela disponível.';
      for (const source of sources) {
        const button = document.createElement('button'); button.className = 'source';
        const image = document.createElement('img'); image.src = source.thumbnail; image.alt = '';
        const label = document.createElement('span'); label.textContent = source.name;
        button.append(image, label); button.onclick = () => finish(source.id); list.appendChild(button);
      }
    }).catch(error => finish(null, error));
  });
};
const updateStatus = document.getElementById('update-status');
window.screenShare.info().then(info => { document.getElementById('version').textContent = `v${info.version}`; });
window.screenShare.onUpdate(update => {
  updateStatus.textContent = update.message;
  document.getElementById('install-update').classList.toggle('hidden', !update.ready);
});
document.getElementById('check-update').onclick = async () => {
  try { updateStatus.textContent = (await window.screenShare.checkUpdate()).message; }
  catch (error) { updateStatus.textContent = error.message; }
};
document.getElementById('install-update').onclick = async () => {
  if (document.getElementById('stop').disabled === false) { updateStatus.textContent = 'Encerre a transmissão antes de instalar.'; return; }
  try { await window.screenShare.installUpdate(); } catch (error) { updateStatus.textContent = error.message; }
};
