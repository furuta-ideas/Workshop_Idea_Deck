// Isolated real Edge mouse/keyboard regression. No production data, SMTP or Notion connection.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createApp, configuration } from '../server/index.js';
import { Store, newWorkshop, newTeam } from '../server/store.js';

const store = new Store(':memory:'),
  email = 'editor@example.test',
  w = newWorkshop('ブラウザー操作テスト', email),
  team = Object.values(w.teams)[0];
w.members[email].role = '編集者';
team.nodes = [
  { id: 'a', text: '最初の案', parent: 'theme', group: 0 },
  { id: 'b', text: '次の案', parent: 'theme', group: 1 },
  { id: 'b1', text: '次の案の子', parent: 'b', group: 2 },
  { id: 'c', text: '３番目の案', parent: 'theme', group: 3 },
];
const other = newTeam('B班');
other.nodes = [{ id: 'other', text: '他チームの案', parent: 'theme', group: 1 }];
w.teams[other.id] = other;
store.put('workshops', w.id, w);
store.put('users', email, { id: 'browser-editor', email, admin: false, passkeys: [] });
const config = configuration({ PORT: '0' }),
  document = readFileSync(new URL('../config/ai-facilitator.md', import.meta.url), 'utf8');
config.facilitatorDocument = document;
const app = createApp(config, { store, sendOtp: async () => {} });
store.put('kv', 'genspark-credential', { key: 'gsk_browser_fixture_only' });
store.put('kv', 'ai', { provider: 'genspark-gsk', model: 'fixture-model' });
const aiInputs = [];
app.ai.genspark.run = async (task, input) => {
  aiInputs.push({ task, input });
  if (task === 'transcribe') {
    const bytes = Buffer.from(input.audio, 'base64');
    assert.equal(input.mimeType, 'audio/wav');
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    assert.equal(bytes.readUInt32LE(24), 16000);
    assert.ok(bytes.length > 16000, 'Audio must contain actual captured samples');
    return { text: 'テストテスト、音声のテストです。' };
  }
  return {
    should_speak: true,
    message_id: 'fixture-' + aiInputs.length,
    phase: input.phase,
    message_type: input.question ? 'help_answer' : 'perspective_shift',
    robot_animation: 'speaking',
    bubble_text: input.question
      ? 'リーフィーです。まずは身近な人と体験会を開いてみませんか？'
      : '誰に役立つか考えてみましょう。',
    duration_ms: 10000,
    reason_code: 'FIXTURE',
  };
};
const addr = await app.start();
config.origin = `http://127.0.0.1:${addr.port}`;
let cookie;
app.auth.session(email, {
  setHeader: (key, value) => {
    if (key === 'Set-Cookie') cookie = value.split(';')[0];
  },
});
const profile = resolve('test-results/edge-interactions-' + Date.now());
mkdirSync(profile, { recursive: true });
const fakeMic = resolve(profile, 'fake-mic.wav'),
  samples = 16000 * 4,
  wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++)
  wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 8000), 44 + i * 2);
writeFileSync(fakeMic, wav);
const edge = spawn(
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=' + fakeMic,
    '--remote-debugging-port=4345',
    '--remote-allow-origins=http://localhost:4345',
    '--window-size=1600,1050',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { windowsHide: true, stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let socket,
  seq = 0,
  closeBrowser;
const pending = new Map(),
  errors = [];
try {
  let targets;
  for (let i = 0; i < 80; i++) {
    try {
      targets = await (await fetch('http://127.0.0.1:4345/json/list')).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  assert.ok(targets, 'Edge did not start');
  socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => {
    socket.onopen = r;
    socket.onerror = j;
  });
  socket.onmessage = (e) => {
    const message = JSON.parse(e.data);
    if (message.id) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      message.error ? p?.reject(Error(JSON.stringify(message.error))) : p?.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  closeBrowser = () => send('Browser.close');
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await sleep(70);
    }
    throw Error(
      'Timed out: ' +
        expression +
        ' state=' +
        (await evaluate(
          "JSON.stringify({view:document.querySelector('#app').dataset.view,text:document.body.innerText.slice(-350),events:window.dragEvents,toast:document.querySelector('#toast').textContent})",
        )),
    );
  };
  const rect = (selector) =>
    evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing selector');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,top:r.top,bottom:r.bottom,left:r.left};})()`,
    );
  const mouse = async (type, x, y, extra = {}) =>
    send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  const click = async (selector) => {
    const p = await rect(selector);
    await mouse('mouseMoved', p.x, p.y);
    await mouse('mousePressed', p.x, p.y, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', p.x, p.y, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(120);
  };
  const drag = async (source, target, after = true) => {
    const a = await rect(source),
      b = await rect(target),
      dest = { x: a.x, y: after ? b.bottom + 4 : b.top - 4 };
    await mouse('mouseMoved', a.x, a.y);
    await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 14; i++) {
      await mouse('mouseMoved', a.x + ((dest.x - a.x) * i) / 14, a.y + ((dest.y - a.y) * i) / 14, {
        button: 'left',
        buttons: 1,
      });
      await sleep(15);
    }
    await mouse('mouseReleased', dest.x, dest.y, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(180);
  };
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1050,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const [name, value] = cookie.split('=');
  await send('Network.setCookie', {
    name,
    value,
    url: config.origin,
    httpOnly: true,
    sameSite: 'Strict',
  });
  await send('Page.navigate', { url: config.origin });
  await until("!!document.querySelector('#login-entry') && !document.querySelector('#app').hidden");
  await evaluate("document.querySelector('#login-entry').click()");
  await until('!!document.querySelector(\'[data-node="a"]\')');
  await evaluate(
    "document.querySelector('#fit-map').click();window.dragEvents=[];for(const type of ['pointerdown','pointermove','pointerup','click'])document.addEventListener(type,e=>{if(type!=='pointermove'||e.buttons)window.dragEvents.push([type,e.target.dataset?.node||e.target.tagName,e.clientX,e.clientY])},true);document.fonts.ready",
  );
  await sleep(500);
  await drag('[data-node="a"]', '[data-node="c"]');
  await until(
    "[...document.querySelectorAll('[data-node]')].map(b=>b.dataset.node).join(',')==='b,b1,c,a'",
  );
  await drag('[data-node="a"]', '[data-node="b"]', false);
  await until("document.querySelector('[data-node]').dataset.node==='a'");
  // Alt+down no longer changes topic order.
  await click('[data-node="a"]');
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowDown',
    code: 'ArrowDown',
    modifiers: 1,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowDown',
    code: 'ArrowDown',
    modifiers: 1,
  });
  assert.equal(store.get('workshops', w.id).teams[team.id].nodes[0].id, 'a');
  // The right side of a topic remains a child-connection target, even for short labels.
  {
    const source = await rect('[data-node="a"]'),
      target = await rect('[data-node="c"]');
    const x = target.left + (target.x - target.left) * 1.7;
    await mouse('mouseMoved', source.x, source.y);
    await mouse('mousePressed', source.x, source.y, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 12; i++) {
      await mouse(
        'mouseMoved',
        source.x + ((x - source.x) * i) / 12,
        source.y + ((target.y - source.y) * i) / 12,
        { button: 'left', buttons: 1 },
      );
      await sleep(15);
    }
    await mouse('mouseReleased', x, target.y, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(180);
    assert.equal(
      store.get('workshops', w.id).teams[team.id].nodes.find((n) => n.id === 'a').parent,
      'c',
    );
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2 });
    await sleep(180);
    assert.equal(
      store.get('workshops', w.id).teams[team.id].nodes.find((n) => n.id === 'a').parent,
      'theme',
    );
  }
  await click('[data-timer="cards"]');
  await until('!!document.querySelector(\'[data-topic-votes="a"] [data-delta="1"]\')');
  await click('[data-topic-votes="a"] [data-delta="1"]');
  await until("document.querySelector('[data-topic-votes=\"a\"] .topic-total')?.textContent==='1'");
  await click('[data-topic-votes="a"] [data-delta="-1"]');
  await until('!document.querySelector(\'[data-topic-votes="a"] .topic-total\')');
  await click('[data-topic-votes="a"] [data-delta="1"]');
  await click('[data-tab="1"]');
  await until('!!document.querySelector(\'[data-card="a"]\')');
  await click('[data-card="a"] [data-delta="1"]');
  await until("document.querySelector('[data-card=\"a\"] .badge')?.textContent==='2'");
  await click('[data-card="a"] [data-delta="-1"]');
  await until("document.querySelector('[data-card=\"a\"] .badge')?.textContent==='1'");
  await click('[data-tab="2"]');
  await until('!!document.querySelector(\'[data-card="a"]\')');
  await evaluate(
    "document.querySelector('#headline').value='新しい価値';document.querySelector('#feature-0').value='簡単に始められる';document.querySelector('#headline').dispatchEvent(new Event('input',{bubbles:true}));",
  );
  const from = await rect('[data-card="a"]'),
    to = await rect('[data-slot="2"]');
  await mouse('mouseMoved', from.x, from.y);
  await mouse('mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 16; i++) {
    await mouse(
      'mouseMoved',
      from.x + ((to.x - from.x) * i) / 16,
      from.y + ((to.y - from.y) * i) / 16,
      { button: 'left', buttons: 1 },
    );
    await sleep(15);
  }
  await mouse('mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1 });
  await until('!!document.querySelector(\'[data-slot="2"] [data-deck-card="a"]\')');
  assert.deepEqual(store.get('workshops', w.id).teams[team.id].deck, ['a']);
  await click('#discussion-form button[type="submit"],#discussion-form button.primary:not([type])');
  await until("!document.querySelector('#toast').textContent.includes('入力')");
  assert.equal(store.get('workshops', w.id).teams[team.id].discussion.headline, '新しい価値');
  assert.equal(
    store.get('workshops', w.id).teams[team.id].discussion.features[0],
    '簡単に始められる',
  );
  assert.equal(await evaluate("!!document.querySelector('.discussion-control')"), false);
  await evaluate('window.scrollTo(0,0)');
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).then((r) =>
    import('node:fs').then((fs) =>
      fs.writeFileSync('test-results/browser-deck-v012.png', Buffer.from(r.data, 'base64')),
    ),
  );
  assert.deepEqual(errors, []);
  await click('#next-advice');
  await until("!!document.querySelector('#advice-question')");
  await click('[data-chat-character="leafy"]');
  await click('#advice-question');
  await send('Input.insertText', { text: 'この企画の最初の一歩を教えてください' });
  await click('#advice-chat-form button.primary');
  await until("document.querySelector('#chat-log').textContent.includes('体験会')");
  const chat = aiInputs.filter((x) => x.input.question).at(-1);
  assert.equal(chat.input.screen.discussion.headline, '新しい価値');
  assert.equal(chat.input.character, 'leafy');
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('.character-picker img')].every(i=>i.complete && i.naturalWidth>0)",
    ),
    true,
  );
  await send('Page.captureScreenshot', { format: 'png' }).then((r) =>
    writeFileSync('test-results/browser-chat-v013.png', Buffer.from(r.data, 'base64')),
  );
  await click('#modal-close');
  await click('#record-discussion');
  await until("!!document.querySelector('#recording-level')");
  await sleep(1700);
  await click('#record-discussion');
  await until("document.querySelector('#transcript').value.includes('音声のテストです')");
  assert.ok(aiInputs.some((x) => x.task === 'transcribe'));
  assert.equal(store.get('workshops', w.id).teams[team.id].discussion.transcript, '');
  assert.deepEqual(errors, []);
  console.log(
    'Real Edge: character chat + screen context + fake microphone capture → 16kHz WAV → transcript draft: PASS (Genspark response mocked)',
  );
  console.log(
    'Real Edge mouse: up/down drag, removed Alt shortcuts, editor voting in tabs 1/2, shortlist→deck drag, new discussion fields: PASS',
  );
} finally {
  await Promise.race([closeBrowser?.().catch(() => {}), sleep(1000)]);
  socket?.close();
  edge.kill();
  app.server.closeAllConnections();
  await app.close();
}
