import { id, hash } from './store.js';
import { Fault, requireThat, text } from './domain.js';
import { imagePrompt, pressReleasePrompt } from './generation-prompts.js';
import { Genspark, defaultImageModel } from './genspark.js';
// An image model name typed into the text-model box (e.g. "gpt-image-2.6") belongs
// to the image model setting instead.
const imageModelPattern = /^(gpt-image|nano-banana|fal-ai\/|qwen-image|xai\/grok-imagine|flux)/i;
const modelName = (v) => {
  const m = text(v || '', 100);
  requireThat(!m || /^[A-Za-z0-9._:@/-]+$/.test(m), "モデル名は英数字と記号（. _ : @ / -）で入力してください");
  return m;
};
export const tasks = [
  'questions',
  'classify',
  'transcribe',
  'summarize',
  'keywords',
  'pressRelease',
  'image',
];
// Find the remaining credit balance in Genspark's /me answer. The field name is not
// documented, so prefer a numeric "credit…" field that reads like a balance.
export function creditBalance(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  let fallback = null;
  for (const [key, v] of Object.entries(value)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
    if (Number.isFinite(n) && /credit/i.test(key) && !/card|cost|used|spent|limit|price|rate/i.test(key)) {
      if (/remain|balance|available|left|current/i.test(key)) return n;
      fallback ??= n;
    }
  }
  if (fallback !== null) return fallback;
  for (const v of Object.values(value)) {
    const n = creditBalance(v, depth + 1);
    if (n !== null) return n;
  }
  return null;
}
// The full allowance the balance counts down from (e.g. monthly plan credits), if
// Genspark reports one.
export function creditTotal(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  for (const [key, v] of Object.entries(value)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
    if (
      Number.isFinite(n) &&
      n > 0 &&
      /credit/i.test(key) &&
      /total|limit|quota|allowance|monthly|plan|max|grant/i.test(key) &&
      !/used|spent|remain|balance|left|card|cost|price/i.test(key)
    )
      return n;
  }
  for (const v of Object.values(value)) {
    const n = creditTotal(v, depth + 1);
    if (n !== null) return n;
  }
  return null;
}
export class AI {
  constructor(store, config, transport = fetch) {
    this.store = store;
    this.config = config;
    this.transport = transport === fetch ? fetch.bind(globalThis) : transport;
    this.genspark = new Genspark(this.transport);
    // The balance lives in memory only (no storage writes); usage stats are stored.
    this.credit = { balance: null, at: 0, error: '' };
    this.creditPending = null;
    this.inflight = 0;
  }
  refreshCredit(force = false) {
    const key = this.gskKey();
    if (!key || (!force && Date.now() - this.credit.at < 300000)) return Promise.resolve(this.credit);
    this.creditPending ||= this.genspark
      .request('me', key, undefined, { timeout: 20000 })
      .then((me) => {
        const balance = creditBalance(me);
        this.credit = {
          balance,
          total: creditTotal(me) ?? this.creditPeak(balance),
          at: Date.now(),
          error: balance === null ? 'Gensparkの応答に残クレジットが見つかりません' : '',
        };
      })
      .catch((e) => {
        this.credit = { ...this.credit, at: Date.now(), error: e.message };
      })
      .finally(() => (this.creditPending = null));
    return this.creditPending.then(() => this.credit);
  }
  // Without a reported allowance, use the highest balance seen this month as "full".
  // Stored only when it rises or the month changes, so it rarely writes.
  creditPeak(balance) {
    if (!Number.isFinite(balance)) return null;
    const month = new Date().toISOString().slice(0, 7),
      saved = this.store.get('kv', 'genspark-credit-peak');
    if (saved?.month === month && saved.peak >= balance) return saved.peak;
    this.store.put('kv', 'genspark-credit-peak', { month, peak: balance });
    return balance;
  }
  creditStatus() {
    return {
      ...this.credit,
      usage: this.store.get('kv', 'ai-usage') || {},
    };
  }
  // Credits one AI task used, from the balance before and after it. Only measured
  // when no other AI task ran at the same time.
  recordUsage(task, before, alone) {
    const after = this.credit.balance;
    if (!alone || before === null || after === null || before < after) return;
    const usage = this.store.get('kv', 'ai-usage') || {};
    const u = usage[task] || { count: 0, total: 0 };
    usage[task] = {
      count: u.count + 1,
      total: Math.round((u.total + (before - after)) * 100) / 100,
      last: Math.round((before - after) * 100) / 100,
      at: Date.now(),
    };
    this.store.put('kv', 'ai-usage', usage);
  }
  settings() {
    let saved = this.store.get('kv', 'ai') || {};
    // v0.17: move once to the low-cost defaults (text: automatic free/low-cost model,
    // image: gpt-image-2). A model chosen after this stays as chosen.
    if (saved.provider && (saved.modelDefaults || 0) < 2) {
      saved = { ...saved, model: '', imageModel: defaultImageModel, modelDefaults: 2 };
      this.store.put('kv', 'ai', saved);
    }
    const misplaced = imageModelPattern.test(saved.model || '');
    // A stored Genspark key is used even when the saved service is an Enterprise gateway
    // that is not configured on this server; otherwise every AI button stays off.
    const enterpriseReady = this.config.providers.some(
      (p) => p.id === saved.provider && p.endpoint && p.keyEnv && process.env[p.keyEnv],
    );
    return {
      provider: 'genspark-enterprise',
      model: '',
      ...saved,
      ...(saved.provider !== 'genspark-gsk' && !enterpriseReady && this.gskKey() ? { provider: 'genspark-gsk' } : {}),
      ...(misplaced ? { model: '' } : {}),
      imageModel: saved.imageModel || (misplaced ? saved.model : defaultImageModel),
      imagePrompt: saved.imagePrompt || imagePrompt,
      pressReleasePrompt: saved.pressReleasePrompt || pressReleasePrompt,
    };
  }
  gskKey() {
    return this.store.get('kv', 'genspark-credential')?.key || process.env.GSK_API_KEY;
  }
  async connect(key) {
    requireThat(
      typeof key === 'string' && /^gsk[-_]\S{10,}$/.test(key) && key.length < 1000,
      'GensparkのGSK APIキーを入力してください',
    );
    await this.genspark.verify(key);
    this.store.put('kv', 'genspark-credential', { key });
    this.store.put('kv', 'ai', { ...this.settings(), provider: 'genspark-gsk' });
    return this.publicSettings();
  }
  async beginLogin(actor) {
    const login = await this.genspark.beginLogin(),
      requestId = id(),
      now = Date.now();
    this.store.put('challenges', requestId, {
      type: 'genspark-login',
      actor,
      deviceCode: login.deviceCode,
      interval: login.interval,
      nextPoll: now + login.interval * 1000,
      expires: now + login.expiresIn * 1000,
    });
    return {
      requestId,
      authUrl: login.authUrl,
      pollMs: login.interval * 1000,
      expiresAt: now + login.expiresIn * 1000,
    };
  }
  async finishLogin(requestId, actor) {
    const c = this.store.get('challenges', requestId),
      now = Date.now();
    requireThat(
      c?.type === 'genspark-login' && c.actor === actor,
      'Genspark認証を最初から開始してください',
      403,
    );
    if (c.expires < now) {
      this.store.del('challenges', requestId);
      return { status: 'expired' };
    }
    if (now < c.nextPoll) return { status: 'pending' };
    c.nextPoll = now + c.interval * 1000;
    this.store.put('challenges', requestId, c);
    const response = c.pendingKey
      ? { status: 'approved', api_key: c.pendingKey }
      : await this.genspark.pollLogin(c.deviceCode);
    if (response.status === 'expired') {
      this.store.del('challenges', requestId);
      return { status: 'expired' };
    }
    if (response.status !== 'approved' || !response.api_key) return { status: 'pending' };
    c.pendingKey = response.api_key;
    this.store.put('challenges', requestId, c);
    const ai = await this.connect(c.pendingKey);
    this.store.del('challenges', requestId);
    return { status: 'connected', ai };
  }
  async diagnose() {
    const key = this.gskKey();
    requireThat(key, 'Genspark APIキーが未設定です。「Gensparkにブラウザーで接続」から接続してください', 503);
    return { ...(await this.genspark.diagnose(key)), provider: this.settings().provider };
  }
  publicSettings() {
    return {
      ...this.settings(),
      lastError: this.store.get('kv', 'ai-last-error') || null,
      approved: [
        {
          id: 'genspark-gsk',
          label: 'Genspark（公式GSK API）',
          capabilities: tasks,
          approvalReference: 'Genspark専用接続',
          ready: !!this.gskKey(),
        },
        ...this.config.providers
          .filter((p) => p.id.startsWith('genspark'))
          .map(({ id, label, capabilities, approvalReference, keyEnv, endpoint }) => ({
            id,
            label,
            capabilities,
            approvalReference,
            ready: !!(endpoint && keyEnv && process.env[keyEnv]),
          })),
      ],
    };
  }
  save(body) {
    const provider = text(body.provider, 100);
    requireThat(
      provider === 'genspark-enterprise' ||
        provider === 'genspark-gsk' ||
        this.config.providers.some((p) => p.id === provider && p.id.startsWith('genspark')),
      '会社承認済みの接続先を選択してください',
    );
    let model = modelName(body.model),
      imageModel = modelName(body.imageModel ?? this.settings().imageModel);
    if (imageModelPattern.test(model)) {
      imageModel = model;
      model = '';
    }
    const result = {
      provider,
      model,
      imageModel: imageModel || defaultImageModel,
      imagePrompt: text(body.imagePrompt ?? this.settings().imagePrompt, 6000),
      pressReleasePrompt: text(body.pressReleasePrompt ?? this.settings().pressReleasePrompt, 6000),
      modelDefaults: 2,
    };
    this.store.put('kv', 'ai', result);
    return this.publicSettings();
  }
  // Ask Genspark which image models this key may use right now.
  async imageModels() {
    const setting = this.settings();
    requireThat(this.gskKey(), 'Genspark APIキーが未設定です。管理者設定で接続してください', 503);
    const schema = await this.genspark.imageSchema(this.gskKey());
    return {
      current: setting.imageModel,
      available: schema.models,
      usable: schema.models.length ? schema.models.includes(setting.imageModel) : null,
    };
  }
  async run(task, payload, actor) {
    requireThat(tasks.includes(task), '未対応のAI処理です');
    const setting = this.settings(),
      provider = this.config.providers.find((p) => p.id === setting.provider);
    if (setting.provider === 'genspark-gsk') {
      requireThat(this.gskKey(), 'Genspark APIキーが未設定です。管理者設定で登録してください', 503);
      const requestId = id();
      this.store.audit('ai-start', {
        requestId,
        task,
        provider: 'genspark-gsk',
        model: task === 'image' ? setting.imageModel : setting.model || null,
        actor: hash(actor),
      });
      const alone = this.inflight === 0;
      this.inflight++;
      const before = alone ? (await this.refreshCredit(Date.now() - this.credit.at > 60000)).balance : null;
      let measured = alone;
      try {
        const result = await this.genspark.run(task, payload, this.gskKey(), setting);
        this.store.audit('ai-complete', { requestId, ended: new Date().toISOString() });
        measured &&= this.inflight === 1;
        await this.refreshCredit(true);
        this.recordUsage(task, before, measured);
        return result;
      } catch (e) {
        void this.refreshCredit(true);
        const message =
          e instanceof Fault
            ? e.message
            : `Gensparkへの接続に失敗しました（${e?.name === 'TimeoutError' ? '時間切れ' : String(e?.message || e?.name || '不明').slice(0, 120)}）。自動再送は行いません`;
        this.store.audit('ai-error', { requestId, task, message, ended: new Date().toISOString() });
        this.store.put('kv', 'ai-last-error', { task, message, at: Date.now() });
        if (e instanceof Fault) throw e;
        throw new Fault(502, message);
      } finally {
        this.inflight--;
      }
    }
    requireThat(setting.provider.startsWith('genspark'), 'AIはGenspark経由のみ利用できます', 503);
    requireThat(
      provider?.approvalReference && provider.capabilities?.includes(task),
      'このAI機能は接続・社内認可が未設定です。手動で入力できます',
      503,
    );
    requireThat(
      provider.endpoint && provider.keyEnv && process.env[provider.keyEnv],
      '承認済みAIの接続情報が未設定です',
      503,
    );
    const endpoint = new URL(provider.endpoint);
    requireThat(
      endpoint.protocol === 'https:' &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash,
      'AIの接続設定が不正です',
      503,
    );
    if (task === 'image')
      requireThat(
        setting.imagePrompt,
        '画像生成プロンプトが未設定です。管理者が設定してください',
        503,
      );
    const requestId = id(),
      started = new Date().toISOString();
    this.store.audit('ai-start', {
      requestId,
      task,
      provider: provider.id,
      model: task === 'image' ? setting.imageModel : setting.model || null,
      started,
      actor: hash(actor),
    });
    try {
      const response = await this.transport(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(90000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env[provider.keyEnv]}`,
        },
        body: JSON.stringify({
          requestId,
          task,
          ...(task === 'image'
            ? { model: setting.imageModel }
            : setting.model
              ? { model: setting.model }
              : {}),
          input: payload,
          ...(task === 'image' ? { prompt: setting.imagePrompt, aspectRatio: '16:9' } : {}),
          ...(task === 'pressRelease' ? { prompt: setting.pressReleasePrompt } : {}),
        }),
      });
      requireThat(response.ok, '承認済みAIの処理が失敗しました', 502);
      const raw = await response.text();
      requireThat(raw.length < 12 * 1024 * 1024, 'AIの応答が大きすぎます', 502);
      const result = JSON.parse(raw);
      this.store.audit('ai-complete', { requestId, ended: new Date().toISOString() });
      return result;
    } catch (e) {
      this.store.audit('ai-error', { requestId, ended: new Date().toISOString() });
      if (e instanceof Fault) throw e;
      throw new Fault(502, '承認済みAIの接続に失敗しました');
    }
  }
}
