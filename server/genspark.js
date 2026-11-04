import { Fault, requireThat } from './domain.js';

const origin = 'https://www.genspark.ai';
const schemas = {
  questions: '{"questions":["質問"]}',
  classify: '{"groups":[{"name":"観点","nodeIds":["既存のID"]}]}（最大8組）',
  summarize:
    '{"headline":"100文字以内","who":"40文字以内","what":"40文字以内","how":"120文字以内","points":"論点を改行で列挙","keywords":"語1、語2"}',
  keywords: '{"keywords":"語1、語2"}',
};
export class Genspark {
  constructor(transport) {
    this.transport = transport;
  }
  async request(path, key, body, { ndjson = false, timeout = 180000 } = {}) {
    const r = await this.transport(`${origin}/api/tool_cli/${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    requireThat(
      r.ok,
      r.status === 401
        ? 'Genspark APIキーを確認してください（401）'
        : `Genspark接続に失敗しました（${r.status}）`,
      502,
    );
    const raw = await r.text();
    requireThat(raw.length < 12 * 1024 * 1024, 'Gensparkの応答が大きすぎます', 502);
    if (!ndjson) return JSON.parse(raw);
    let final;
    for (const line of raw.trim().split('\n')) {
      try {
        const item = JSON.parse(line);
        if ((item.version ?? 1) <= 1 && item.status) final = item;
      } catch {}
    }
    requireThat(
      final?.status === 'ok',
      'Gensparkの生成が完了しませんでした。重複生成を避けるため、自動再送は行いません',
      502,
    );
    return final.data;
  }
  async verify(key) {
    const result = await this.request('me', key, undefined, { timeout: 20000 });
    requireThat(result && result.status !== 'error', 'Genspark APIキーを確認してください', 502);
  }
  async text(task, payload, key, setting) {
    // Discover the official proxy URL and permitted model catalog instead of guessing endpoints.
    const catalog = await this.request('opencode-config', key);
    const provider = catalog.provider?.['genspark-llm-proxy'];
    requireThat(
      provider?.options?.baseURL && provider.models,
      'Gensparkの文章生成モデル一覧を取得できません',
      502,
    );
    const base = new URL(provider.options.baseURL);
    requireThat(
      base.protocol === 'https:' &&
        (base.hostname === 'genspark.ai' || base.hostname.endsWith('.genspark.ai')) &&
        !base.username &&
        !base.password &&
        !base.search &&
        !base.hash,
      'Gensparkの接続先を確認してください',
      502,
    );
    const model =
      setting.model ||
      (catalog.model?.startsWith('genspark-llm-proxy/')
        ? catalog.model.slice('genspark-llm-proxy/'.length)
        : '');
    requireThat(
      model && Object.hasOwn(provider.models, model),
      'Gensparkで利用可能な文章モデルを管理者設定に指定してください',
      503,
    );
    const instruction =
      task === 'pressRelease'
        ? setting.pressReleasePrompt
        : payload.mode === 'facilitation'
          ? `${payload.systemInstructions}\nresponseSchemaに厳密に従うJSONのみを出力してください。`
          : `日本語で回答し、次の形式のJSONのみを出力してください：${schemas[task]}`;
    const r = await this.transport(`${base.href.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(180000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        stream: false,
      }),
    });
    requireThat(r.ok, 'Gensparkの文章生成に失敗しました', 502);
    const raw = await r.text();
    requireThat(raw.length < 200000, '文章生成の応答が大きすぎます', 502);
    const content = JSON.parse(raw).choices?.[0]?.message?.content;
    requireThat(
      typeof content === 'string' && content.trim(),
      'Gensparkから文章が返りませんでした',
      502,
    );
    if (task === 'pressRelease') return { text: content.trim() };
    try {
      return JSON.parse(content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    } catch {
      throw new Fault(502, 'Gensparkの応答形式を確認してください');
    }
  }
  async run(task, payload, key, setting) {
    if (task === 'image') {
      const data = await this.request(
        'image_generation',
        key,
        {
          query: `${setting.imagePrompt}\n\n企画内容：\n${JSON.stringify(payload)}\n出力形式はPNG画像。`,
          model: 'gpt-image-2.5',
          aspect_ratio: '16:9',
          image_size: '2k',
          tier: 'flare',
        },
        { ndjson: true, timeout: 300000 },
      );
      const url = data?.generated_images?.[0]?.image_urls?.[0];
      requireThat(typeof url === 'string', 'Gensparkから画像が返りませんでした', 502);
      const imageUrl = new URL(url, origin);
      const allowed = [
        'genspark.ai',
        'gensparksite.com',
        'gensparkspace.com',
        'genaicdn.com',
        'gensparkpublicblob.blob.core.windows.net',
      ];
      requireThat(
        imageUrl.protocol === 'https:' &&
          allowed.some((h) => imageUrl.hostname === h || imageUrl.hostname.endsWith('.' + h)) &&
          !imageUrl.username &&
          !imageUrl.password,
        'Gensparkの画像URLを確認してください',
        502,
      );
      const image = await this.transport(imageUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });
      requireThat(image.ok, '生成画像を取得できませんでした', 502);
      const bytes = Buffer.from(await image.arrayBuffer());
      requireThat(bytes.length <= 8 * 1024 * 1024, '生成画像が大きすぎます', 502);
      return { pngBase64: bytes.toString('base64') };
    }
    if (task === 'transcribe') {
      // Follow the official CLI's get-upload-url + private blob upload contract.
      const upload = await this.request(
        'file/upload_url',
        key,
        {
          content_type: payload.mimeType,
          name: 'discussion.webm',
        },
        { ndjson: true },
      );
      const info = upload.data || upload,
        url = info.file_wrapper_url;
      requireThat(
        typeof url === 'string' && typeof info.upload_url === 'string',
        'Gensparkの録音アップロード応答を確認してください',
        502,
      );
      const destination = new URL(info.upload_url);
      requireThat(
        destination.protocol === 'https:' &&
          destination.hostname.endsWith('.blob.core.windows.net') &&
          !destination.username &&
          !destination.password,
        'Gensparkの録音保存先を確認してください',
        502,
      );
      const uploaded = await this.transport(destination, {
        method: 'PUT',
        redirect: 'manual',
        signal: AbortSignal.timeout(60000),
        headers: { 'Content-Type': payload.mimeType, 'x-ms-blob-type': 'BlockBlob' },
        body: Buffer.from(payload.audio, 'base64'),
      });
      requireThat(uploaded.ok, 'Gensparkへの録音アップロードに失敗しました', 502);
      const data = await this.request(
        'audio_transcribe',
        key,
        { audio_urls: [url], model: 'whisper-1' },
        { ndjson: true },
      );
      const extract = (value) => {
        if (Array.isArray(value)) return value.map(extract).filter(Boolean).join('\n');
        if (!value || typeof value !== 'object') return '';
        if (typeof value.full_text === 'string' && value.full_text.trim()) return value.full_text;
        if (typeof value.text === 'string' && value.text.trim()) return value.text;
        if (Array.isArray(value.segments)) return value.segments.map((s) => s.text || '').join('');
        return Object.values(value)
          .filter((v) => v && typeof v === 'object')
          .map(extract)
          .filter(Boolean)
          .join('\n');
      };
      const text = extract(data);
      requireThat(text.trim(), '録音から文字を認識できませんでした', 502);
      return { text };
    }
    return this.text(task, payload, key, setting);
  }
}
