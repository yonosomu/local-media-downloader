import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Actual unmodified manifest, no host pregrant. Synthetic session/IDB DTOs below
// test UI states only, never engine execution or native dialogs.
const root = process.cwd(), evidence = path.join(root, 'docs/evidence/t_8590b0cf');
const run = process.env.LMD_KEYBOARD_RUN ?? 'run123';
assert.match(run, /^run[0-9]+(?:-[a-z0-9-]+)?$/);
const scratch = path.join(root, `.test-data/keyboard-${run}`);
await mkdir(scratch, { recursive: true });
const results = [], environment = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 180));
async function targetClient(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId }); let sequence = 0;
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', listener); reject(new Error(`CDP timeout ${method}`)); }, 15000);
    const listener = event => {
      if (event.sessionId !== sessionId) return;
      const reply = JSON.parse(event.message); if (reply.id !== id) return;
      clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', listener);
      if (reply.error) reject(new Error(JSON.stringify(reply.error))); else resolve(reply.result);
    };
    cdp.on('Target.receivedMessageFromTarget', listener);
    void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
  });
}
function surface(client) {
  return {
    client,
    async evaluate(expression) {
      const r = await client('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    },
    async press(key) {
      const shift = key === 'Shift+Tab', plain = shift ? 'Tab' : key;
      const codes = { Tab: 9, Enter: 13, Space: 32, ArrowDown: 40, ArrowUp: 38 };
      const params = { key: plain === 'Space' ? ' ' : plain, code: plain, windowsVirtualKeyCode: codes[plain], modifiers: shift ? 8 : 0 };
      await client('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(plain === 'Enter' ? {text:'\r'} : plain === 'Space' ? {text:' '} : {}) });
      await client('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    }
  };
}
async function until(s, expression) {
  for (let n = 0; n < 100; n++) { if (await s.evaluate(expression)) return; await new Promise(r => setTimeout(r, 40)); }
  throw new Error(`Condition timeout: ${expression}`);
}
const controls = 'a[href],button,input,select,textarea';
async function walk(s) {
  const inventory = await s.evaluate(`(() => {
    const all = [...document.querySelectorAll('${controls}')];
    all.forEach((e,i)=>e.dataset.auditId=String(i));
    return all.filter(e=>!e.disabled && !e.hidden && e.getClientRects().length && e.tabIndex>=0).map(e=>e.dataset.auditId);
  })()`);
  assert(inventory.length > 1);
  // Explicit anchor; subsequent traversal is real Tab/Shift+Tab, not focus().
  await s.evaluate(`document.querySelector('[data-audit-id="${inventory[0]}"]').focus()`);
  const observed = [];
  for (let n = 0; n < inventory.length; n++) {
    const focused = await s.evaluate(`(() => {const e=document.activeElement,s=getComputedStyle(e);return {id:e.dataset.auditId,visible:e.matches(':focus-visible'),width:s.outlineWidth,style:s.outlineStyle,color:s.outlineColor};})()`);
    assert.equal(focused.id, inventory[n], 'Tab order / focus trap');
    assert.equal(focused.visible, true); assert.equal(focused.width, '3px'); assert.equal(focused.style, 'solid');
    observed.push(focused);
    if (n + 1 < inventory.length) await s.press('Tab');
  }
  for (let n = inventory.length - 2; n >= 0; n--) {
    await s.press('Shift+Tab'); assert.equal(await s.evaluate('document.activeElement.dataset.auditId'), inventory[n], 'Reverse Tab order');
  }
  const tree = await s.client('Accessibility.getFullAXTree');
  const interactive = tree.nodes.filter(n => !n.ignored && ['button','link','textbox','combobox','checkbox','spinbutton'].includes(n.role?.value));
  assert(interactive.length > 0);
  for (const n of interactive) assert(n.name?.value?.trim(), `Unnamed ${n.role.value}`);
  return { tabOrder: inventory, observed, accessibleControls: interactive.map(n => ({ role: n.role.value, name: n.name.value, disabled: n.properties?.find(p=>p.name==='disabled')?.value.value ?? false })) };
}
async function seek(s, selector) {
  // A known document anchor avoids invoking any action with mouse/programmatic click.
  await s.evaluate(`document.querySelector('nav a').focus()`);
  for (let n = 0; n < 100; n++) {
    if (await s.evaluate(`document.activeElement.matches(${JSON.stringify(selector)})`)) return;
    await s.press('Tab');
  }
  throw new Error(`Keyboard target unreachable: ${selector}`);
}
for (const [browser, executablePath] of Object.entries({ chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })) {
  const profile = await mkdtemp(path.join(scratch, `${browser}-`));
  const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'], acceptDownloads: true, downloadsPath: path.join(profile, 'downloads') });
  const errors = []; context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  async function check(id, action) {
    try { const details = await action(); results.push({ browser, id, status: 'passed', ...details }); }
    catch (error) { results.push({ browser, id, status: 'failed', error: error.message }); console.error(browser, id, error.message); }
  }
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
    const base = `chrome-extension://${id}/ui`;
    const options = await context.newPage(); await options.goto(`${base}/options/index.html`);
    const os = surface((method, params) => optionsSession.send(method, params));
    const optionsSession = await context.newCDPSession(options);
    await until(os, '!!document.querySelector("input[name=quality]") || !!document.querySelector("select[name=quality]")');
    await until(os, '[...document.querySelectorAll("button")].some(b=>b.textContent===chrome.i18n.getMessage("diagnostics"))');
    async function command(type, payload = {}) {
      return options.evaluate(async ({type,payload}) => { const r=await chrome.runtime.sendMessage({version:1,requestId:crypto.randomUUID(),type,payload}); if(!r?.ok) throw new Error(JSON.stringify(r)); return r.data; }, {type,payload});
    }
    await command('GET_SETTINGS');
    environment.push({ browser, version: execFileSync(executablePath, ['--version'], {encoding:'utf8'}).trim(), chromium: context.browser().version(), profile, extensionId: id, permissions: await options.evaluate(()=>chrome.permissions.getAll()), mode:'headless; default protections unchanged; no native dialogs' });
    const fixture = await context.newPage(); await fixture.goto('about:blank');
    const tabId = await options.evaluate(async()=> (await chrome.tabs.query({active:true,currentWindow:true}))[0].id);
    async function restart() { await optionsSession.send('ServiceWorker.enable'); await optionsSession.send('ServiceWorker.stopAllWorkers'); await command('GET_SETTINGS'); }
    async function openPopup() {
      await fixture.bringToFront(); await options.evaluate(()=>chrome.action.openPopup());
      const target = (await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url===`${base}/popup/index.html`); assert(target);
      const s = surface(await targetClient(cdp,target.targetId));
      await until(s,'!!document.querySelector("#site input")');
      return {...s, close:async()=>{await cdp.send('Target.closeTarget',{targetId:target.targetId});await pause();}};
    }
    const manager = await context.newPage(); await manager.goto(`${base}/manager/index.html`);
    const managerSession = await context.newCDPSession(manager), ms = surface((m,p)=>managerSession.send(m,p));
    await until(ms,'!!document.querySelector("select")');
    for (const theme of ['light','dark']) {
      for (const [screen,s] of [['options',os],['manager',ms]]) await check(`${screen}-${theme}-empty-keyboard-names-focus`,async()=>{
        await s.client('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
        const detail=await walk(s); detail.colors=await s.evaluate('({background:getComputedStyle(document.body).backgroundColor,color:getComputedStyle(document.body).color,theme:matchMedia("(prefers-color-scheme:dark)").matches})');
        assert.equal(detail.colors.theme,theme==='dark');
        const shot=await s.client('Page.captureScreenshot'); const file=`${run}-${browser}-${screen}-${theme}.png`; await writeFile(path.join(evidence,file),Buffer.from(shot.data,'base64'));return {...detail,screenshot:file};
      });
      const pop=await openPopup();
      try { await check(`popup-${theme}-nohost-empty-keyboard-names-focus`,async()=>{
        await pop.client('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
        const detail=await walk(pop);assert((await pop.evaluate('document.body.innerText')).includes('Нет доступа'));
        const shot=await pop.client('Page.captureScreenshot');const file=`${run}-${browser}-popup-empty-${theme}.png`;await writeFile(path.join(evidence,file),Buffer.from(shot.data,'base64'));return {...detail,screenshot:file};
      }); } finally {await pop.close();}
    }
    await check('options-keyboard-space-save-focus',async()=>{
      const before=await command('GET_SETTINGS');await seek(os,'input[name=subtitlesEnabled]');await os.press('Space');
      assert.equal(await os.evaluate('document.querySelector("[name=subtitlesEnabled]").checked'),!before.settings.subtitlesEnabled);
      await seek(os,'form button');await os.press('Enter');
      await until(os,'document.getElementById("status").textContent.includes("Настройки сохранены")');await pause();
      assert.equal((await command('GET_SETTINGS')).settings.subtitlesEnabled,!before.settings.subtitlesEnabled);
      assert.equal(await os.evaluate('document.activeElement.matches("form button")'),true,'Settings save discarded keyboard focus');
    });
    // Synthetic DTOs in own storage only; no source fetch or grant performed.
    await options.evaluate(async tabId=>{
      const id=crypto.randomUUID(),sourceRef=crypto.randomUUID(),documentKey=crypto.randomUUID();
      const candidate={id,sourceRef,documentKey,tabId,frameId:0,generation:1,revision:1,title:'Keyboard synthetic HLS',sourceOrigin:'https://fixture.invalid',protocol:'hls',isLive:false,detectedAt:Date.now(),support:'supported',variants:[{id:'v',height:720,codecs:['avc1.42c01f'],hasAudio:false}],audioTracks:[{id:'a',kind:'audio',label:'Русский',language:'ru',codec:'aac'}],subtitleTracks:[{id:'s',kind:'subtitle',language:'ru',label:'Текст'}],capabilities:{pause:false,resume:false,requiresSourceTab:false,containers:['mp4','mkv']}};
      await chrome.storage.session.set({registry:{revision:1,bindings:[],entries:[{candidate,source:{sourceRef,exactUrl:'https://fixture.invalid/never-fetched.m3u8',tabId,frameId:0,documentKey,generation:1,discoveredOrigins:[]},requiredOrigins:[]}]}});
    },tabId);await restart();
    let pop=await openPopup();
    try {
      await until(pop,'!!document.querySelector("article button")');
      for(const theme of ['light','dark']) await check(`popup-${theme}-synthetic-tracks-keyboard`,async()=>{
        await pop.client('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});const detail=await walk(pop);
        await seek(pop,'input[name="subtitle:s"]');const before=await pop.evaluate('document.activeElement.checked');await pop.press('Space');assert.equal(await pop.evaluate('document.activeElement.checked'),!before);
        const shot=await pop.client('Page.captureScreenshot');const file=`${run}-${browser}-popup-tracks-${theme}.png`;await writeFile(path.join(evidence,file),Buffer.from(shot.data,'base64'));return {...detail,screenshot:file,scope:'synthetic DTO; no engine execution'};
      });
      await check('popup-header-focus-survives-space-update',async()=>{
        await seek(pop,'#site input[name=discovery]');await pop.press('Space');await pause();await pause();
        assert.equal(await pop.evaluate('document.activeElement.matches("#site input[name=discovery]")'),true,'Header update discarded focus');
      });
      await check('popup-action-focus-survives-metadata',async()=>{
        await seek(pop,'article button');
        await options.evaluate(async()=>{const {registry}=await chrome.storage.session.get('registry');registry.entries[0].candidate.revision++;registry.entries[0].candidate.title='Keyboard updated';registry.revision++;await chrome.storage.session.set({registry});});
        await restart();await until(pop,'document.querySelector("article h2").textContent==="Keyboard updated"');
        assert.equal(await pop.evaluate('document.activeElement.matches("article button")'),true,'Metadata update discarded action focus');
      });
    } finally {await pop.close();}
    await options.evaluate(async()=>{
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('lmd-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const tx=db.transaction(['jobs','exports'],'readwrite');const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
      for(const [n,state] of ['downloading','failed','awaiting_export','completed_with_warnings'].entries()){
        const id=`keyboard-${n}`;tx.objectStore('jobs').put({schemaVersion:1,id,requestId:crypto.randomUUID(),candidateId:'test-only',state,selection:{container:'original',audioOnly:false,subtitleTrackIds:[]},outputName:`${id}.mp4`,createdAt:Date.now(),updatedAt:Date.now(),bytesWritten:10,attempt:1,revision:1,runEpoch:1,capabilities:{pause:n===0,resume:false},warnings:n===3?[{code:'SEGMENT_MISSING',message:'Тест: разрыв',retryable:false}]:[],outputs:[],...(n===1?{error:{code:'NETWORK_OFFLINE',message:'Тест: сеть недоступна',retryable:false}}:{})});
        tx.objectStore('exports').put({id:`context:${id}`,title:`Клавиатура ${state}`,domain:'fixture.invalid',isLive:false,sourceRef:'test-only',relativeDirectory:'',saveAs:false});
      }await done;db.close();
    });
    await manager.reload();await until(ms,'document.querySelectorAll("article").length===4');
    for(const theme of ['light','dark']) await check(`manager-${theme}-synthetic-states-keyboard`,async()=>{
      await ms.client('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});const detail=await walk(ms);const text=await ms.evaluate('document.body.innerText');assert(text.includes('NETWORK_OFFLINE'));assert(text.includes('Ожидание')||text.includes('ожидает'));assert(text.includes('Тест: разрыв'));
      const shot=await ms.client('Page.captureScreenshot');const file=`${run}-${browser}-manager-states-${theme}.png`;await writeFile(path.join(evidence,file),Buffer.from(shot.data,'base64'));return {...detail,screenshot:file,scope:'injected snapshots; not transport errors'};
    });
    await check('manager-action-focus-survives-refresh',async()=>{
      await seek(ms,'article button');const before=await ms.evaluate('({job:document.activeElement.closest("article").dataset.jobId,text:document.activeElement.textContent})');
      await ms.evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent===chrome.i18n.getMessage("refresh")).click()');await pause();
      // Invoke the real refresh handler while an action is focused, modelling an
      // event-driven snapshot. This trigger itself is not a keyboard assertion.
      await until(ms,'document.querySelectorAll("article").length===4');
      assert.deepEqual(await ms.evaluate('({job:document.activeElement.closest("article")?.dataset.jobId,text:document.activeElement.textContent})'),before,'Snapshot refresh discarded manager action focus');
    });
    await check('manager-keyboard-native-select',async()=>{
      await manager.bringToFront();await seek(ms,'select');await manager.keyboard.press('Space');await manager.keyboard.press('ArrowDown');await manager.keyboard.press('Enter');await pause();
      const actual = await ms.evaluate('document.querySelector("select").value');
      if (actual !== 'active') {
        // Distinguish a product regression from the installed headless browser's
        // inability to drive even an unstyled HTML select. Never call this passed.
        const control = await context.newPage();
        try {
          await control.setContent('<label>Filter<select><option value="all">Все</option><option value="active">Активные</option></select></label>');
          await control.locator('select').focus();
          for (const key of ['Space','ArrowDown','Enter']) await control.keyboard.press(key);
          const vanilla = await control.locator('select').inputValue();
          assert.equal(vanilla, 'all', 'Vanilla select works: investigate product failure');
          return {status:'blocked',actual,vanilla,reason:'Same keyboard sequence leaves both product and plain HTML select unchanged in installed macOS headless browser. Requires operator keyboard selection; not a passed select test.'};
        } finally {await control.close();}
      }
      return {actual};
    });
    await check('manager-DOM-select-filter-and-keyboard-refresh-space',async()=>{
      // Explicit DOM selection tests filtering only, NOT native keyboard selection.
      await manager.bringToFront();await manager.locator('select').selectOption('active');
      await until(ms,'document.querySelectorAll("article").length===2');
      await seek(ms,'#main > button:last-child');await ms.press('Space');await pause();assert.equal(await ms.evaluate('document.querySelector("select").value'),'active');
      return {scope:'DOM selectOption for filter change; real Space activation for refresh'};
    });
    await check('page-errors-and-no-hosts',async()=>{assert.deepEqual(errors,[]);assert.deepEqual((await options.evaluate(()=>chrome.permissions.getAll())).origins,[]);return {errors};});
  } finally {await context.close();}
}
const report={scope:'SPEC7.3 bounded keyboard/AX/style audit; actual manifest CDP load; own profiles; synthetic DTOs explicitly marked; not native acceptance, VoiceOver or full WCAG',environment,results,counts:Object.fromEntries(['passed','failed','blocked'].map(status=>[status,results.filter(r=>r.status===status).length]))};
await writeFile(process.env.LMD_KEYBOARD_REPORT??path.join(evidence,`${run}-keyboard.json`),JSON.stringify(report,null,2));
console.log(JSON.stringify(report.counts));if(report.counts.failed)process.exitCode=1;
