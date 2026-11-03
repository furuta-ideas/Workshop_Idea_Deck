import { id, hash } from './store.js';
import { Fault, requireThat, text } from './domain.js';
export const tasks = ['questions', 'classify', 'transcribe', 'summarize', 'keywords', 'image'];
export class AI {
  constructor(store, config, transport = fetch) {
    this.store = store;
    this.config = config;
    this.transport = transport;
  }
  settings() {
    return (
      this.store.get('kv', 'ai') || { provider: 'genspark-enterprise', model: '', imagePrompt: '' }
    );
  }
  publicSettings() {
    return {
      ...this.settings(),
      approved: this.config.providers.map(
        ({ id, label, capabilities, approvalReference, keyEnv, endpoint }) => ({
          id,
          label,
          capabilities,
          approvalReference,
          ready: !!(endpoint && keyEnv && process.env[keyEnv]),
        }),
      ),
    };
  }
  save(body) {
    const provider = text(body.provider, 100);
    requireThat(
      provider === 'genspark-enterprise' || this.config.providers.some((p) => p.id === provider),
      '会社承認済みの接続先を選択してください',
    );
    const result = {
      provider,
      model: text(body.model || '', 150),
      imagePrompt: text(body.imagePrompt || '', 6000),
    };
    this.store.put('kv', 'ai', result);
    return this.publicSettings();
  }
  async run(task, payload, actor) {
    requireThat(tasks.includes(task), '未対応のAI処理です');
    const setting = this.settings(),
      provider = this.config.providers.find((p) => p.id === setting.provider);
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
      model: setting.model || null,
      started,
      actor: hash(actor),
    });
    try {
      const response = await this.transport(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(90000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env[provider.keyEnv]}`,
        },
        body: JSON.stringify({
          requestId,
          task,
          ...(setting.model ? { model: setting.model } : {}),
          input: payload,
          ...(task === 'image' ? { prompt: setting.imagePrompt, aspectRatio: '16:9' } : {}),
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
