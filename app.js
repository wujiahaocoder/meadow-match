(function () {
  'use strict';
  const E = window.MeadowEngine, V = window.MeadowVault;
  const $ = id => document.getElementById(id);
  const clone = data => structuredClone(data);
  const names = ['胡萝卜','玉米','白菜','蘑菇','苹果','萝卜','茄子','梨子','南瓜','辣椒','小花','橡果'];
  const nodes = new Map();
  const modal = $('modal');
  let session = null, locked = false, generating = false, toastTimer, modalEpoch = 0;
  let storageOK = true, saveSequence = 0, workerJob = 0, resizePending = false;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, reducedMotion.matches ? 5 : ms));
  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3400);
  }
  function setLocked(value) {
    locked = value;
    document.body.classList.toggle('in-operation', value);
    updateControls();
    if (!value && resizePending && session) { resizePending = false; render(); }
  }
  function setBusy(value, label) {
    generating = value;
    $('busy-cover').hidden = !value;
    if (label) $('busy-label').textContent = label;
    updateControls();
  }
  function closeModal() { modalEpoch++; modal.close(); }
  function openModal(title, content) {
    modalEpoch++;
    modal.innerHTML = '<div class="modal-top"><h2 id="modal-title"></h2><button class="close-button" aria-label="关闭弹窗">×</button></div>' + content;
    $('modal-title').textContent = title;
    modal.querySelector('.close-button').onclick = closeModal;
    if (!modal.open) modal.showModal();
    return modalEpoch;
  }
  modal.addEventListener('click', event => {
    if (event.target === modal) {
      const r = modal.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeModal();
    }
  });
  modal.addEventListener('cancel', () => { modalEpoch++; });
  function confirmAction(title, description, label, action) {
    openModal(title, '<p class="modal-description" id="confirm-description"></p><div class="modal-actions"><button class="secondary" id="confirm-cancel">再想想</button><button class="primary" id="confirm-ok"></button></div>');
    $('confirm-description').textContent = description;
    $('confirm-ok').textContent = label;
    $('confirm-cancel').onclick = closeModal;
    $('confirm-ok').onclick = async () => { closeModal(); await action(); };
  }
  function setSaveStatus(text, error = false) {
    $('save-status').textContent = text;
    $('save-status').classList.toggle('save-status-error', error);
    $('mobile-save-status').textContent = error ? '本地保存不可用，请导出存档' : '';
    $('mobile-save-state').textContent = error ? '保存失败' : text.includes('正在') ? '正在保存' : '已自动保存';
    $('mobile-save-state').classList.toggle('save-status-error', error);
  }
  async function autoSave() {
    if (!session) return;
    session.updatedAt = new Date().toISOString();
    const seq = ++saveSequence;
    setSaveStatus('正在保存这片田园…');
    try {
      await V.save(session);
      storageOK = true;
      if (seq === saveSequence) setSaveStatus('✓ 已自动保存在此设备');
    } catch (error) {
      storageOK = false;
      if (seq === saveSequence) setSaveStatus('本地保存不可用，请及时导出存档', true);
    }
  }
  function produce(type) {
    return '<svg class="produce" viewBox="0 0 64 64" aria-hidden="true"><use href="#p'+type+'"/></svg>';
  }
  function makeTile(id) {
    const el = document.createElement('button');
    el.className = 'tile'; el.type = 'button'; el.dataset.id = id;
    el.addEventListener('click', () => act('pick', id));
    nodes.set(id, el);
    return el;
  }
  function updateControls() {
    const inactive = !session || locked || generating;
    const g = session?.game;
    $('undo-btn').disabled = inactive || !g?.tools.undo || !g?.undo;
    $('move-btn').disabled = inactive || g?.status !== 'playing' || !g?.tools.move || !g?.tray.length;
    $('shuffle-btn').disabled = inactive || g?.status !== 'playing' || !g?.tools.shuffle || g?.places.filter(p => p === 'board').length < 2;
    for (const id of ['restart-btn','next-btn','new-btn','export-btn','export-mobile','restore-btn','restore-mobile','board-info-btn','self-test-btn']) $(id).disabled = inactive;
    if (g) for (const key of ['undo','move','shuffle']) {
      $(key+'-count').textContent = '×'+g.tools[key];
      const button = $(key+'-btn');
      const description = {undo:'撤回最近一次有效操作',move:'移出最多三张到备用区',shuffle:'重新分配场上的图案'}[key];
      button.title = g.tools[key] ? description+'，本局剩余 1 次' : '本局次数已用完';
    }
  }
  function trayGeometry(index) {
    const rect = $('tray-items').getBoundingClientRect();
    const slots = $('tray').querySelectorAll('.slot');
    const r = slots[Math.min(index,6)].getBoundingClientRect();
    const size = Math.min(r.width, r.height);
    return { left:r.left - rect.left, top:(rect.height-size)/2, size, x:r.left, y:rect.top+(rect.height-size)/2 };
  }
  function render(fresh = false) {
    if (!session) return;
    const {layout,game:g} = session;
    $('reserve-row').dataset.empty = String(g.reserve.length === 0);
    if (fresh) { for (const node of nodes.values()) node.remove(); nodes.clear(); }
    const graph = E.blockers(layout);
    for (const tile of layout.tiles) {
      const id = tile.id, place = g.places[id];
      let node = nodes.get(id);
      if (place === 'gone') { if (node) node.remove(); continue; }
      if (!node) node = makeTile(id);
      if (node.dataset.type !== String(g.types[id])) {
        node.innerHTML = produce(g.types[id]); node.dataset.type = String(g.types[id]);
      }
      const blocked = place === 'board' && graph[id].some(other => g.places[other] === 'board');
      node.classList.toggle('blocked', blocked);
      node.disabled = blocked || g.status !== 'playing';
      node.setAttribute('aria-label', names[g.types[id]]+(blocked ? '，被上层遮挡' : place === 'reserve' ? '，从备用区收回' : '，点击收集'));
      node.setAttribute('aria-disabled', String(node.disabled));
      if (place === 'board') {
        if (node.parentNode !== $('board')) $('board').append(node);
        Object.assign(node.style,{left:tile.x/420*100+'%',top:tile.y/400*100+'%',width:52/420*100+'%',height:52/400*100+'%',zIndex:String(10+tile.z)});
      } else if (place === 'tray') {
        if (node.parentNode !== $('tray-items')) $('tray-items').append(node);
        const r = trayGeometry(g.tray.indexOf(id));
        Object.assign(node.style,{left:r.left+'px',top:r.top+'px',width:r.size+'px',height:r.size+'px',zIndex:'20'});
      } else if (place === 'reserve') {
        if (node.parentNode !== $('reserve')) $('reserve').append(node);
        const index = g.reserve.indexOf(id);
        const parentRect = $('reserve').getBoundingClientRect();
        const slotRect = $('reserve').querySelectorAll('.reserve-slot')[index].getBoundingClientRect();
        Object.assign(node.style,{left:slotRect.left-parentRect.left+'px',top:'0px',width:slotRect.width+'px',height:slotRect.height+'px',zIndex:'20'});
      }
    }
    $('level-label').textContent = '第 '+String(session.level).padStart(2,'0')+' 关';
    $('remaining-label').textContent = g.places.filter(p => p === 'board').length;
    $('tray-count').textContent = g.tray.length+' / 7';
    $('tray-tip').textContent = g.tray.length >= 6 ? '只剩 1 格，先找能凑齐的图案' : g.tray.length >= 5 ? '空位不多了，先凑齐三个' : '三个相同，自动消除';
    if (g.status === 'lost') $('tray-tip').textContent = '槽位已满，再试一次吧';
    $('tray-tip').style.color = g.tray.length >= 5 ? '#9b673a' : '';
    $('tray').dataset.pressure = g.status === 'lost' ? 'lost' : g.tray.length >= 6 ? 'danger' : g.tray.length >= 5 ? 'warn' : 'calm';
    $('tray').querySelectorAll('.slot').forEach((slot, i) => {
      slot.dataset.slot = String(i + 1);
      slot.dataset.filled = String(i < g.tray.length);
    });
    const progress = Math.round(g.places.filter(p => p === 'gone').length / layout.tiles.length * 100);
    $('harvest-fill').style.width = progress+'%';
    $('harvest-progress').setAttribute('aria-valuenow', String(progress));
    $('harvest-label').textContent = '已收好 '+progress+'%';
    $('state-label').textContent = g.status === 'won' ? '收集完成' : g.status === 'lost' ? '槽位已满' : '悠闲收集中';
    $('state-label').dataset.state = g.status;
    $('sheep-speech').textContent = g.status === 'won' ? '又收好一片好心情。' : g.status === 'lost' ? '休息一下，再出发。' : g.tray.length >= 5 ? '给空位留一点余地。' : '别着急，慢慢来。';
    $('sheep-hint').textContent = g.status === 'won' ? '下一片田园，等你一起去' : g.tray.length >= 5 ? '先凑三个，再接下一张' : '小羊会一直陪着你 ♡';
    $('cleared-label').innerHTML = session.cleared+'<span>关</span>';
    $('next-btn').hidden = g.status !== 'won';
    updateControls();
  }
  function capture() {
    const rects = new Map();
    for (const [id,node] of nodes) if (node.isConnected) rects.set(id,{rect:node.getBoundingClientRect(),node:node.cloneNode(true)});
    return rects;
  }
  function animateMoved(before, excluded = []) {
    if (reducedMotion.matches) return;
    for (const [id,node] of nodes) {
      if (!node.isConnected || excluded.includes(id)) continue;
      const previous = before.get(id);
      if (!previous) {
        node.animate([{opacity:0,scale:'.6'},{opacity:1,scale:'1'}],{duration:260});
        continue;
      }
      const a = previous.rect, b = node.getBoundingClientRect();
      if (Math.abs(a.left-b.left)+Math.abs(a.top-b.top)>1 || Math.abs(a.width-b.width)>1) {
        node.animate([{transform:'translate('+(a.left-b.left)+'px,'+(a.top-b.top)+'px) scale('+(a.width/b.width)+','+(a.height/b.height)+')'},{transform:'translate(0,0) scale(1)'}],{duration:310,easing:'cubic-bezier(.22,.75,.2,1)'});
      }
    }
  }
  function burst(x,y,count=12,celebrate=false) {
    if (reducedMotion.matches) return;
    const rng = E.random(x+'|'+y+'|'+performance.now());
    for (let i=0;i<count;i++) {
      const p = document.createElement('i'); p.className='particle';
      p.style.background = ['#a7bf77','#e4c375','#e7aa8c','#f5efcf','#7b9b6b'][i%5];
      p.style.left=x+'px';p.style.top=y+'px';document.body.append(p);
      const angle=rng()*Math.PI*2, distance=(celebrate?110:30)+rng()*(celebrate?230:35);
      const animation=p.animate([{transform:'translate(0,0) rotate(0)',opacity:1},{transform:'translate('+Math.cos(angle)*distance+'px,'+(Math.sin(angle)*distance+(celebrate?160:20))+'px) rotate('+(rng()*600)+'deg)',opacity:0}],{duration:celebrate?1250:650,easing:'cubic-bezier(.1,.7,.4,1)'});
      animation.finished.then(()=>p.remove()).catch(()=>p.remove());
    }
  }
  async function animateMatch(before, matched, interimOrder) {
    const animations = [];
    for (const id of matched) {
      const previous = before.get(id);
      if (!previous) continue;
      const r = trayGeometry(interimOrder.indexOf(id));
      const ghost = previous.node;
      ghost.className='tile ghost';ghost.disabled=true;
      const a=previous.rect;
      Object.assign(ghost.style,{left:a.left+'px',top:a.top+'px',width:a.width+'px',height:a.height+'px',zIndex:'10000'});
      document.body.append(ghost);
      if (!reducedMotion.matches) {
        const animation=ghost.animate([
          {transform:'translate(0,0) scale(1)',opacity:1,offset:0},
          {transform:'translate('+(r.x-a.left)+'px,'+(r.y-a.top)+'px) scale('+(r.size/a.width)+')',opacity:1,offset:.57},
          {transform:'translate('+(r.x-a.left)+'px,'+(r.y-a.top)+'px) scale('+(r.size/a.width*1.12)+')',opacity:1,offset:.72},
          {transform:'translate('+(r.x-a.left)+'px,'+(r.y-a.top)+'px) scale(.1)',opacity:0,offset:1}
        ],{duration:560,easing:'cubic-bezier(.22,.7,.25,1)'});
        animations.push(animation.finished.catch(()=>{}).then(()=>ghost.remove()));
      } else ghost.remove();
    }
    await sleep(340);
    for (const id of matched) { const r=trayGeometry(interimOrder.indexOf(id)); burst(r.x+r.size/2,r.y+r.size/2,7); }
    await Promise.all(animations);
  }
  async function act(kind,id) {
    if (!session || locked || generating) return;
    if (kind === 'pick' && (session.game.status !== 'playing' || !E.isAvailable(session.layout,session.game,id))) return;
    setLocked(true);
    const before=capture(), g=session.game;
    let interimOrder=g.tray.slice();
    if (kind==='pick') {
      let index=interimOrder.length;
      for(let i=interimOrder.length-1;i>=0;i--) if(g.types[interimOrder[i]]===g.types[id]){index=i+1;break;}
      interimOrder.splice(index,0,id);
    }
    let result;
    try {
      if(kind==='pick') result=E.pick(session.layout,g,id);
      else if(kind==='undo') result=E.undo(session.layout,g);
      else if(kind==='move') result=E.takeOut(session.layout,g);
      else if(kind==='shuffle') result=E.shuffle(session.layout,g,session.seed+'|'+session.level+'|'+session.layout.retry+'|'+g.places.join(',')+'|'+g.tray.join(','));
      if(!result?.ok) return;
      if(g.status==='won') session.cleared=Math.max(session.cleared,session.level);
      render();
      animateMoved(before,result.matched||[]);
      const saving=autoSave();
      if(result.matched?.length) await animateMatch(before,result.matched,interimOrder);
      else if(kind==='shuffle'&&!reducedMotion.matches) {
        for(const tileId of result.ids) nodes.get(tileId)?.animate([{transform:'scale(1)'},{transform:'scale(.75) rotate(-5deg)',offset:.45},{transform:'scale(1)'}],{duration:380});
        await sleep(390);
      } else await sleep(330);
      await saving;
      if(g.status==='won') {const r=$('board').getBoundingClientRect();burst(r.x+r.width/2,r.y+r.height/2,55,true);showResult();}
      else if(g.status==='lost') {
        if(!reducedMotion.matches) $('tray').animate([{transform:'translateX(0)'},{transform:'translateX(-7px)'},{transform:'translateX(7px)'},{transform:'translateX(-4px)'},{transform:'translateX(0)'}],{duration:320});
        await sleep(280); showResult();
      }
    } catch(error) { toast('这一步没有完成：'+error.message); }
    finally {setLocked(false);}
  }
  function generateWorker(seed,level,retry) {
    return new Promise((resolve,reject)=>{
      let worker,url,timer;
      const done=(error,data)=>{clearTimeout(timer);if(worker)worker.terminate();if(url)URL.revokeObjectURL(url);error?reject(error):resolve(data);};
      try {
        if(!window.Worker) throw new Error('当前浏览器不支持后台关卡生成，请使用现代浏览器。');
        const source=$('engine-code').textContent+'\nself.onmessage=async function(event){try{const x=event.data; const layout=await MeadowEngine.generate(x.seed,x.level,x.retry);self.postMessage({layout:layout});}catch(e){self.postMessage({error:e.message});}};';
        url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
        worker=new Worker(url);
        worker.onmessage=event=>event.data.error?done(new Error(event.data.error)):done(null,event.data.layout);
        worker.onerror=()=>done(new Error('后台生成失败，请重试或使用支持本地 Worker 的现代浏览器。'));
        timer=setTimeout(()=>done(new Error('关卡生成超时，当前进度已保留。请重试。')),6500);
        worker.postMessage({seed,level,retry});
      } catch(error){done(error);}
    });
  }
  async function uniqueLayout(seed,level,history,startRetry=0) {
    const known=new Set(history);
    for(let retry=startRetry;retry<startRetry+12;retry++) {
      const layout=await generateWorker(seed,level,retry);
      if(!E.verifyLayout(layout).valid || await E.fingerprint(layout)!==layout.fingerprint) throw new Error('新关卡没有通过规则验证，请重试。');
      if(!known.has(layout.fingerprint)) return layout;
    }
    throw new Error('本次生成连续遇到重复关卡，请重试。当前进度已保留。');
  }
  async function newGame() {
    if(locked||generating) return;
    const previous=session;
    setBusy(true,'小羊正在种下一片田园…');
    const job=++workerJob;
    try {
      const seed=V.newSeed();
      const history=previous?.history||[];
      const layout=await uniqueLayout(seed,1,history);
      if(job!==workerJob)return;
      const now=new Date().toISOString();
      const candidate={format:1,generator:1,seed,level:1,highest:1,cleared:0,layout,game:E.createGame(layout),history:[...history,layout.fingerprint].slice(-V.HISTORY_LIMIT),createdAt:now,updatedAt:now};
      // The previous game is retained until the entire candidate passes validation.
      await V.validate(candidate);
      session=candidate;render(true); await autoSave();
      if(previous)toast('一段全新的田园旅程开始了');
    }catch(error){showGenerationError(error,previous?()=>newGame():()=>initialize());}
    finally{setBusy(false);}
  }
  function showGenerationError(error,retry) {
    openModal('田园还需要一点时间','<p class="modal-description" id="generation-error"></p><div class="modal-actions"><button class="primary" id="generation-retry">再试一次</button></div>');
    $('generation-error').textContent=error.message;
    $('generation-retry').onclick=()=>{closeModal();retry();};
  }
  async function nextLevel() {
    if(locked||generating||session?.game.status!=='won')return;
    closeModal();
    if(session.level===Number.MAX_SAFE_INTEGER) {toast('已达到此版本可精确表示的关卡编号上限，请新建旅程。');return;}
    setBusy(true,'正在生成下一片全新田园…');
    try {
      const level=session.level+1,layout=await uniqueLayout(session.seed,level,session.history);
      session={...session,level,highest:Math.max(session.highest,level),layout,game:E.createGame(layout),history:[...session.history,layout.fingerprint].slice(-V.HISTORY_LIMIT)};
      render(true);await autoSave();
      if(level===2)toast('第二关开始，先看看哪些图案能凑成三个');
    }catch(error){showGenerationError(error,()=>nextLevel());}
    finally{setBusy(false);}
  }
  async function restart() {
    if(locked||generating||!session)return;
    closeModal();session.game=E.createGame(session.layout);render(true);await autoSave();toast('同一片田园，重新出发');
  }
  function showResult() {
    if(!session)return;
    const win=session.game.status==='won';
    openModal(win?'收集完成':'休息一下，再出发','<div class="result-body"><svg class="result-art" viewBox="0 0 180 160"><use href="#sheep"/></svg><h2>'+(win?'这片田园，收好啦！':'差一点，就凑齐了。')+'</h2><p>'+(win?'第 '+session.level+' 关已完成。<br>下一片田园，会长出怎样的新惊喜？':'收集槽已经装满七张。<br>再观察一下遮挡，下一次会更从容。')+'</p><div class="modal-actions"><button class="secondary" id="result-secondary">'+(win?'再玩本关':session.game.tools.undo&&session.game.undo?'撤回最后一步':'重新开始')+'</button><button class="primary" id="result-primary">'+(win?'去下一片田园 →':'再试一次')+'</button></div><button class="text-button" id="result-export" style="margin:18px auto 0">导出此刻的存档</button></div>');
    $('result-primary').onclick=win?nextLevel:restart;
    $('result-secondary').onclick=win?restart:session.game.tools.undo&&session.game.undo?()=>{closeModal();act('undo');}:restart;
    $('result-export').onclick=exportSave;
  }
  async function copyText(text) {
    try {if(navigator.clipboard?.writeText) {await navigator.clipboard.writeText(text);toast('已完整复制');return;}}catch{}
    const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';
    (modal.open?modal:document.body).append(area);area.select();area.setSelectionRange(0,area.value.length);
    const ok=document.execCommand('copy');area.remove();toast(ok?'已完整复制':'自动复制不可用，请长按或全选文本复制');
  }
  async function exportSave() {
    if(!session||locked||generating)return;
    const snapshot=clone(session),epoch=openModal('把这片田园带走','<p class="modal-description">保存下面两个代码，就能在兼容设备上继续此刻的进度。每次导出的密文都会不同。</p><div id="export-content"><div class="spinner" style="margin:25px auto"></div><p class="modal-description" style="text-align:center">正在安全加密…</p></div><p class="security-note">种子相当于恢复密钥。请妥善保存两个代码；同时持有它们的人可以恢复和读取完整进度。</p>');
    try {
      const code=await V.encrypt(snapshot.seed,snapshot);
      if(epoch!==modalEpoch||!modal.open)return;
      $('export-content').innerHTML='<label class="field-label" for="export-seed">游戏种子<button class="copy-small" id="copy-seed">复制种子</button></label><textarea class="seed-output" id="export-seed" readonly spellcheck="false"></textarea><label class="field-label" for="export-code">加密存档码<button class="copy-small" id="copy-code">复制存档码</button></label><textarea id="export-code" readonly spellcheck="false" rows="5"></textarea><div class="modal-meta" id="export-meta"></div><div class="modal-actions"><button class="primary" id="copy-both">一键复制两个代码</button><button class="secondary" id="download-save">保存为文本</button></div><div class="capacity-note" id="export-capacity"></div>';
      $('export-seed').value=snapshot.seed;$('export-code').value=code;
      $('export-meta').textContent='存档 v1 · '+new Date().toLocaleString('zh-CN')+' · '+code.length.toLocaleString()+' 位数字';
      const both='咩咩田园 · 双码存档 v1\n种子：'+snapshot.seed+'\n存档码：'+code+'\n';
      $('copy-seed').onclick=()=>copyText(snapshot.seed);$('copy-code').onclick=()=>copyText(code);$('copy-both').onclick=()=>copyText(both);
      $('download-save').onclick=()=>{
        const url=URL.createObjectURL(new Blob([both],{type:'text/plain;charset=utf-8'}));
        const a=document.createElement('a');a.href=url;a.download='咩咩田园-第'+snapshot.level+'关-双码存档.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      };
      $('export-capacity').textContent='已携带 '+snapshot.history.length+' / '+V.HISTORY_LIMIT+' 条历史指纹。保留最近 '+V.HISTORY_LIMIT+' 关并逐一去重；历史增加时存档码也会变长。有限设备无法保证无限历史绝不重复。';
    }catch(error){if(epoch===modalEpoch){$('export-content').innerHTML='<div class="error-message" id="export-error"></div>';$('export-error').textContent=error.message;}}
  }
  function restoreSave() {
    if(locked||generating)return;
    const epoch=openModal('恢复你的田园','<p class="modal-description">粘贴游戏种子和加密存档码，回到离开时的那一步。也可以把合并复制的两行内容粘贴进任一输入框。</p><label class="field-label" for="restore-seed">游戏种子</label><textarea class="seed-output" id="restore-seed" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="粘贴种子数字"></textarea><label class="field-label" for="restore-code">加密存档码</label><textarea id="restore-code" inputmode="numeric" autocomplete="off" spellcheck="false" rows="5" placeholder="粘贴完整的加密存档数字"></textarea><div class="error-message" id="restore-error" role="alert"></div><div class="modal-actions"><button class="secondary" id="restore-cancel">取消</button><button class="primary" id="restore-decrypt">验证并恢复</button></div><p class="security-note">全部校验通过后才会请求覆盖确认。错误种子、损坏代码或不兼容格式都不会覆盖现有进度。全程离线，无需上传。</p>');
    for(const id of ['restore-seed','restore-code']) $(id).addEventListener('paste',event=>{
      const text=event.clipboardData?.getData('text')||'';
      const seed=text.match(/种子[：:]\s*(\d+)/),code=text.match(/存档码[：:]\s*([\d\s]+)/);
      if(seed&&code){event.preventDefault();$('restore-seed').value=seed[1];$('restore-code').value=code[1].replace(/\s/g,'');}
    });
    $('restore-cancel').onclick=closeModal;
    $('restore-decrypt').onclick=async()=>{
      const button=$('restore-decrypt');button.disabled=true;button.textContent='正在解密与校验…';$('restore-error').textContent='';
      try {
        const seed=$('restore-seed').value.replace(/\s/g,''),code=$('restore-code').value.replace(/\s/g,'');
        const candidate=await V.decrypt(seed,code);
        if(epoch!==modalEpoch||!modal.open)return;
        confirmAction('替换当前进度？','这个存档将恢复到第 '+candidate.level+' 关，收集槽有 '+candidate.game.tray.length+' 张，备用区有 '+candidate.game.reserve.length+' 张。确认后会覆盖此设备当前的本地进度。','确认恢复',async()=>{
          setBusy(true,'正在恢复你的田园…');
          try {
            // replace validates first, then atomically writes current + history.
            await V.replace(candidate);
            session=candidate;storageOK=true;render(true);setSaveStatus('✓ 已恢复并保存在此设备');toast('欢迎回来，田园还是离开时的样子');
            if(session.game.status!=='playing')showResult();
          }catch(error){toast(error.message);}
          finally{setBusy(false);}
        });
      }catch(error){if(epoch===modalEpoch&&modal.open){$('restore-error').textContent=error.message;button.disabled=false;button.textContent='验证并恢复';}}
    };
  }
  function boardInfo() {
    if(!session)return;
    const p=session.layout.params,m=p.metrics;
    openModal('这片田园的信息','<p class="modal-description">每次新关卡都由种子、关卡编号和生成器版本计算生成；重新开始会保留同一布局。</p><div class="help-list" id="info-details"></div><label class="field-label">完整关卡指纹</label><textarea id="info-fingerprint" class="seed-output" readonly></textarea><p class="capacity-note">指纹覆盖坐标、层级、图案和真实遮挡关系，不包含方块 ID。生成时与最近 '+V.HISTORY_LIMIT+' 条记录比较，重复则重新生成；不承诺数学意义上的无限不重复。</p>');
    const lines=['生成器 v'+E.VERSION+' · 第 '+session.level+' 关 · 重试参数 '+session.layout.retry,p.total+' 张方块 · '+p.kinds+' 种图案 · '+p.layers+' 层堆叠','已验证一条无需道具的合法通关路径','初始可选 '+m.initialChoices+' 张 · 路径槽位峰值 '+m.peak+' / 7','遮挡关系 '+m.overlapEdges+' 组 · 路径平均可选 '+m.averageChoices+' 张','已保留 '+session.history.length+' 条完整历史指纹'];
    $('info-details').textContent='';for(const line of lines){const div=document.createElement('div');div.textContent=line;$('info-details').append(div);}
    $('info-fingerprint').value=session.layout.fingerprint;
  }
  function help() {
    openModal('在田园里，三个刚刚好','<p class="modal-description">点选亮色方块，把它放入七格收集槽。三个同样的图案会自动消除；灰色方块需要先移开所有覆盖它的上层方块。</p><ol class="help-list"><li>七格装满且没有三消时失败；消除全部方块即通关。</li><li>撤回恢复上一步；移出将槽内最多三张放进备用区；洗牌只调换场上图案。每种道具每局一次，撤回不会返还已用次数。</li><li>备用区方块可点击收回。失败后若尚有撤回机会，也可以挽回最后一步。</li><li>每关都通过真实遮挡和七格规则的通关路径验证；使用道具后的局面可能改变。</li><li>进度自动存到本机。跨设备请保存种子和加密存档码，恢复时确认覆盖。</li></ol><p class="security-note">原创矢量素材，无外部资源。加密采用 HKDF-SHA-256 和 AES-256-GCM。种子与存档码请视为敏感凭据。客户端加密提供保密与篡改检测，不能防止玩家修改游戏程序。</p><div class="modal-actions"><button class="primary" id="help-start">开始收集</button></div>');
    $('help-start').onclick=closeModal;
  }
  async function selfTest() {
    if(locked||generating)return;
    const epoch=openModal('运行自检','<p class="modal-description">验证算法、规则和加密恢复，不会修改你的当前进度。</p><div class="help-list" id="test-results"></div><p class="modal-meta" id="test-finish">正在检查…</p>');
    const report=(text,ok)=>{if(epoch!==modalEpoch)return;const el=document.createElement('div');el.textContent=(ok?'✓ ':'✗ ')+text;el.style.color=ok?'#6f8b53':'#b1765a';$('test-results').append(el);};
    let passed=0,total=0;
    const check=async(name,fn)=>{total++;try{await fn();passed++;report(name,true);}catch(error){report(name+'：'+error.message,false);}};
    const assert=(v)=>{if(!v)throw new Error('结果不一致');};
    let demo,seed;
    await check('随机种子与关卡确定性复现',async()=>{seed=V.newSeed();const a=await generateWorker(seed,3,0),b=await generateWorker(seed,3,0);assert(JSON.stringify(a)===JSON.stringify(b));demo={format:1,generator:1,seed,level:3,highest:3,cleared:2,layout:a,game:E.createGame(a),history:[a.fingerprint],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};});
    await check('真实遮挡与正向通关验证',async()=>{assert(E.verifyLayout(demo.layout).valid);const g=E.createGame(demo.layout);for(const id of demo.layout.solution){assert(E.isAvailable(demo.layout,g,id));assert(E.pick(demo.layout,g,id).ok);assert(g.tray.length<7);}assert(g.status==='won');});
    await check('完整结构指纹与重复关卡识别',async()=>{const set=new Set([demo.layout.fingerprint]);assert(set.has(await E.fingerprint(demo.layout)));const b=await generateWorker(seed,3,1);assert(!set.has(b.fingerprint));});
    let code;
    await check('中途存档加密、解密与恢复一致',async()=>{for(const id of demo.layout.solution.slice(0,5))E.pick(demo.layout,demo.game,id);code=await V.encrypt(seed,demo);const result=await V.decrypt(seed,code);assert(JSON.stringify(result.game)===JSON.stringify(demo.game));assert(JSON.stringify(result.layout)===JSON.stringify(demo.layout));});
    await check('每次导出使用新的盐与 nonce',async()=>{assert(code!==await V.encrypt(seed,demo));});
    await check('错误种子被拒绝',async()=>{let rejected=false;try{await V.decrypt(V.newSeed(),code);}catch{rejected=true;}assert(rejected);});
    await check('密文篡改被拒绝',async()=>{const bytes=V.decodeDecimal(code);bytes[bytes.length-1]^=1;let rejected=false;try{await V.decrypt(seed,V.encodeDecimal(bytes));}catch{rejected=true;}assert(rejected);});
    await check('跨设备等价恢复并继续通关',async()=>{const restored=await V.decrypt(seed,code);for(const id of restored.layout.solution.slice(5))assert(E.pick(restored.layout,restored.game,id).ok);assert(restored.game.status==='won');});
    if(epoch===modalEpoch)$('test-finish').textContent=passed+' / '+total+' 项通过。'+(passed===total?'你的田园已准备好。':'请查看未通过项目。');
  }
  async function initialize() {
    setBusy(true,'正在找回你的田园…');
    try {
      if(!V.available())throw new Error('当前环境没有安全的 Web Crypto API，无法生成受验证关卡或加密存档。请使用现代浏览器的本地文件、HTTPS 或 localhost。');
      try {session=await V.load();storageOK=true;}
      catch(error){storageOK=false;session=null;setSaveStatus('无法读取本地进度，请从双码恢复',true);toast(error.message);}
      if(session){render(true);setSaveStatus('✓ 已找回上次的田园');if(session.game.status!=='playing')setTimeout(showResult,180);}
      else {setBusy(false);await newGame();}
    }catch(error){showGenerationError(error,initialize);}
    finally{setBusy(false);}
  }
  $('undo-btn').onclick=()=>act('undo');$('move-btn').onclick=()=>act('move');$('shuffle-btn').onclick=()=>act('shuffle');
  $('help-btn').onclick=help;$('board-info-btn').onclick=boardInfo;$('self-test-btn').onclick=selfTest;$('next-btn').onclick=nextLevel;
  $('help-btn').setAttribute('aria-label','玩法说明');$('new-btn').setAttribute('aria-label','新建旅程');
  $('new-btn').onclick=()=>confirmAction('开始一段新旅程？','这会生成全新种子，并替换当前游戏。想保留这片田园，可以先导出双码存档。','新建旅程',newGame);
  $('restart-btn').onclick=()=>confirmAction('重新收集这片田园？','本关会回到最初的布局，所有道具恢复。当前这一局的操作将被清除。','重新开始',restart);
  for(const id of ['export-btn','export-mobile'])$(id).onclick=exportSave;
  for(const id of ['restore-btn','restore-mobile'])$(id).onclick=restoreSave;
  let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(!session)return;if(locked)resizePending=true;else render();},60);}).observe($('tray'));
  // A small read-only bridge supports automated acceptance tests without extra UI.
  window.MeadowGame={getState:()=>session?clone(session):null,ready:()=>!!session&&!generating&&!locked,act,restart,nextLevel,uniqueLayout};
  initialize();
})();
