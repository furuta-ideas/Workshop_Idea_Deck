import { id, hash } from './store.js';
import { Fault, requireThat, text } from './domain.js';
import { imagePrompt, pressReleasePrompt } from './generation-prompts.js';
import { Genspark } from './genspark.js';
export const tasks = [
  'questions',
  'classify',
  'transcribe',
  'summarize',
  'keywords',
  'pressRelease',
  'image',
];
export class AI {
  constructor(store, config, transport = fetch) {
    this.store = store;
    this.config = config;
    this.transport = transport === fetch ? fetch.bind(globalThis) : transport;
    this.genspark = new Genspark(this.transport);
  }
  settings() {
    const saved = this.store.get('kv', 'ai') || {};
    return {
      provider: 'genspark-enterprise',
      model: '',
      ...saved,
      imageModel: 'gpt-image-2.5',
      imagePrompt: saved.imagePrompt || imagePrompt,
      pressReleasePrompt: saved.pressReleasePrompt || pressReleasePrompt,
    };
  }
  gskKey() {
    return this.store.get('kv', 'genspark-credential')?.key || process.env.GSK_API_KEY;
  }
  async connect(key) {
    requireThat(
      typeof key === 'string' && /^gsk-\S{10,}$/.test(key) && key.length < 1000,
      'GensparkのGSK APIキーを入力してください',
    );
    await this.genspark.verify(key);
    this.store.put('kv', 'genspark-credential', { key });
    this.store.put('kv', 'ai', { ...this.settings(), provider: 'genspark-gsk' });
    return this.publicSettings();
  }
  publicSettings() {
    return {
      ...this.settings(),
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
    const result = {
      provider,
      model: text(body.model || '', 150),
      imagePrompt: text(body.imagePrompt ?? this.settings().imagePrompt, 6000),
      pressReleasePrompt: text(body.pressReleasePrompt ?? this.settings().pressReleasePrompt, 6000),
    };
    this.store.put('kv', 'ai', result);
    return this.publicSettings();
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
        model: task === 'image' ? 'gpt-image-2.5' : setting.model || null,
        actor: hash(actor),
      });
      try {
        const result = await this.genspark.run(task, payload, this.gskKey(), setting);
        this.store.audit('ai-complete', { requestId, ended: new Date().toISOString() });
        return result;
      } catch (e) {
        this.store.audit('ai-error', { requestId, ended: new Date().toISOString() });
        if (e instanceof Fault) throw e;
        throw new Fault(502, 'Gensparkへの接続に失敗しました。自動再送は行いません');
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
