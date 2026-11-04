import { Fault, requireThat } from './domain.js';
import { audioType, extractTranscript } from './audio.js';

const origin = 'https://www.genspark.ai';
const schemas = {
  questions: '{"questions":["質問"]}',
  classify: '{"groups":[{"name":"観点","nodeIds":["既存のID"]}]}（最大8組）',
  summarize:
    '{"headline":"100文字以内","who":"40文字以内","what":"40文字以内","how":"120文字以内","features":["特長１を１行の文章で（60文字以内）","特長２","特長３"],"points":"論点を改行で列挙","keywords":"語1、語2"}',
  keywords: '{"keywords":"語1、語2"}',
};
// Genspark's edge WAF admits /api/tool_cli/ calls that carry a short-lived token
// pass (same contract as the official gsk CLI, native-waf.js). Without it, calls from
// a server or a Cloudflare Worker can be refused before they reach Genspark.
const passShape = /^\d{10}-[A-Za-z0-9_-]{43}$/;
const PASS_MS = 240000,
  PASS_FAILURE_MS = 15000;
// The most affordable ChatGPT Image 2.x model; at standard quality it costs no credits on
// Genspark Plus/Pro and about 5 credits at 1K on the free plan.
export const defaultImageModel = 'gpt-image-2';
// Premium image models (2.5 and later) get the 2K size and the "flare" tier.
const premiumImage = /^gpt-image-2\.[5-9]/;
// Text model when none is set: a free model first, then the cheapest one the catalog prices,
// then a light model by name, and only then Genspark's own default.
// A model that answers quickly, by the usual names of the light model lines; '' if none.
export function pickFastModel(models) {
  const ids = Object.keys(models || {});
  for (const name of [/flash-lite/i, /nano/i, /haiku/i, /flash/i, /mini/i, /lite|instant|fast/i]) {
    const found = ids.find((id) => name.test(id) && !/image|audio|embed|tts/i.test(id));
    if (found) return found;
  }
  return '';
}
export function pickTextModel(models, fallback) {
  const ids = Object.keys(models || {});
  const cost = (id) => {
    const c = models[id]?.cost;
    const n = c && typeof c === 'object' ? Number(c.input ?? 0) + Number(c.output ?? 0) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const priced = ids.filter((id) => cost(id) !== null).sort((a, b) => cost(a) - cost(b));
  if (priced.length) return priced[0];
  const flagged = ids.find((id) => models[id]?.free === true || /(^|[-_/])free($|[-_/])/i.test(id));
  if (flagged) return flagged;
  const light = ids.find((id) => /haiku|flash|mini|lite|nano/i.test(id));
  return light || fallback || ids[0] || '';
}
// Readable detail from a Genspark error body, without echoing anything long.
function detail(raw) {
  try {
    const j = JSON.parse(raw);
    const m = j?.message || j?.detail?.message || j?.detail || j?.error?.message || j?.error;
    return typeof m === 'string' ? m.slice(0, 200) : '';
  } catch {
    return '';
  }
}
export class Genspark {
  constructor(transport) {
    this.transport = transport;
    this.passes = new Map();
    this.schemas = new Map();
  }
  async admission(key) {
    if (!key?.startsWith('gsk-')) return {};
    const cached = this.passes.get(key);
    if (cached && cached.until > Date.now())
      return cached.pass ? { 'X-Genspark-Token-Pass': cached.pass } : {};
    let pass = null;
    try {
      const r = await this.transport(`${origin}/api/native-waf/token-pass?family=tool`, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { 'X-Api-Key': key },
      });
      if (r?.ok) {
        const raw = await r.text();
        const data = raw.length < 4096 ? JSON.parse(raw)?.data : null;
        if (data?.family === 'tool' && passShape.test(data?.token || '')) pass = data.token;
      }
    } catch {}
    this.passes.set(key, { pass, until: Date.now() + (pass ? PASS_MS : PASS_FAILURE_MS) });
    return pass ? { 'X-Genspark-Token-Pass': pass } : {};
  }
  async loginRequest(path, body) {
    const r = await this.transport(`${origin}/api/cli_auth/${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    requireThat(r.ok, `Gensparkのブラウザー認証に接続できません（${r.status}）`, 502);
    return r.json();
  }
  async beginLogin() {
    const result = await this.loginRequest('device_code', {}),
      url = new URL(result.auth_url);
    requireThat(
      url.origin === origin &&
        !url.username &&
        !url.password &&
        typeof result.device_code === 'string' &&
        result.device_code.length < 1000,
      'Genspark認証URLの形式が不正です',
      502,
    );
    return {
      deviceCode: result.device_code,
      authUrl: url.href,
      interval: Math.min(30, Math.max(2, Number(result.poll_interval) || 5)),
      expiresIn: Math.min(900, Math.max(60, Number(result.expires_in) || 300)),
    };
  }
  pollLogin(code) {
    return this.loginRequest(`token?code=${encodeURIComponent(code)}`);
  }
  async send(path, key, body, timeout) {
    return this.transport(`${origin}/api/tool_cli/${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      headers: {
        'X-Api-Key': key,
        'Content-Type': 'application/json',
        ...(await this.admission(key)),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async request(path, key, body, { ndjson = false, timeout = 180000, envelope = false } = {}) {
    let r = await this.send(path, key, body, timeout);
    // A 403 from the edge WAF means the call never reached Genspark (stale or missing
    // pass), so one retry with a fresh pass cannot generate twice.
    if (r.status === 403) {
      const why = await r.text().catch(() => '');
      this.passes.delete(key);
      if (!/gsk_|api key|token/i.test(why)) r = await this.send(path, key, body, timeout);
      else r = { ok: false, status: 403, text: async () => why };
    }
    if (!r.ok) {
      const why = detail(await r.text().catch(() => '')) || (r.status === 403 ? 'Gensparkの入口（WAF）で拒否されました' : '');
      if (r.status === 403) this.passes.delete(key);
      throw new Fault(
        502,
        r.status === 401
          ? 'Genspark APIキーを確認してください（401）'
          : r.status === 429
            ? 'Gensparkの利用回数の上限に達しました。少し待ってから再実行してください（429）'
            : `Genspark接続に失敗しました（${r.status}）${why ? '：' + why : ''}`,
      );
    }
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
      `Gensparkの生成が完了しませんでした${final?.message ? '（' + String(final.message).slice(0, 200) + '）' : ''}。重複生成を避けるため、自動再送は行いません`,
      502,
    );
    return envelope ? final : final.data;
  }
  // Admin connection test: each step's HTTP status, without the key or any content.
  async diagnose(key) {
    const steps = [],
      step = async (name, run) => {
        const started = Date.now();
        try {
          const r = await run();
          const raw = await r.text().catch(() => '');
          steps.push({ name, status: r.status, ok: r.ok, detail: r.ok ? '' : detail(raw) || raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160), ms: Date.now() - started });
          return r.ok ? raw : null;
        } catch (e) {
          steps.push({ name, status: 0, ok: false, detail: `${e?.name || 'Error'}: ${String(e?.message || e).slice(0, 160)}`, ms: Date.now() - started });
          return null;
        }
      };
    const keyType = key?.startsWith('gsk-') ? 'gsk-' : key?.startsWith('gsk_') ? 'gsk_' : 'other';
    if (keyType === 'gsk-')
      await step('WAF通行証', () =>
        this.transport(`${origin}/api/native-waf/token-pass?family=tool`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'X-Api-Key': key } }),
      );
    this.passes.delete(key);
    await step('アカウント確認（me）', () => this.send('me', key, undefined, 20000));
    const tools = await step('ツール一覧（tools）', () => this.send('tools', key, undefined, 20000));
    let toolCount = null;
    try { toolCount = JSON.parse(tools || 'null')?.tools?.length ?? null; } catch {}
    return { keyType, steps, toolCount, ok: steps.every((s) => s.ok) };
  }
  async verify(key) {
    const result = await this.request('me', key, undefined, { timeout: 20000 });
    requireThat(result && result.status !== 'error', 'Genspark APIキーを確認してください', 502);
  }
  async text(task, payload, key, setting) {
    // Discover the official proxy URL and permitted model catalog instead of guessing endpoints.
    // The catalog rarely changes; asking for it on every chat message made replies slow.
    this.catalogs ||= new Map();
    let cached = this.catalogs.get(key);
    if (!cached || cached.until < Date.now()) {
      cached = { catalog: await this.request('opencode-config', key), until: Date.now() + 600000 };
      this.catalogs.set(key, cached);
    }
    const catalog = cached.catalog;
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
    // The AI chat and the voice-log summary use a fast model; the rest keep the default.
    // (The chat uses Genspark's standard model: the light models kept asking back.)
    const quick = payload.mode === 'compact';
    const model =
      (quick && (setting.chatModel || pickFastModel(provider.models))) ||
      setting.model ||
      pickTextModel(
        provider.models,
        catalog.model?.startsWith('genspark-llm-proxy/') ? catalog.model.slice('genspark-llm-proxy/'.length) : '',
      );
    requireThat(
      model && Object.hasOwn(provider.models, model),
      'Gensparkで利用可能な文章モデルを管理者設定に指定してください',
      503,
    );
    const instruction =
      task === 'pressRelease'
        ? setting.pressReleasePrompt
        : payload.mode === 'compact'
          ? '次のtranscriptはワークショップの議論の文字起こしです。誰が何を課題と感じ、どんなアイデア・根拠・結論・未解決の論点が出たかを落とさずに、日本語の箇条書きで3000字以内に圧縮してください。固有名詞と数字は残します。{"text":"…"} の形式のJSONのみを出力してください。'
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
  // The live image_generation schema from Genspark: which models this key may use.
  async imageSchema(key) {
    const cached = this.schemas.get(key);
    if (cached && cached.until > Date.now()) return cached.schema;
    const list = await this.request('tools', key, undefined, { timeout: 20000 });
    const tool = (list?.tools || []).find((t) => t?.name === 'image_generation');
    const props = tool?.parameters?.properties || {};
    const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    const schema = {
      models: strings(props.model?.enum),
      tiers: strings(props.tier?.enum),
      sizes: strings(props.image_size?.enum),
    };
    this.schemas.set(key, { schema, until: Date.now() + 600000 });
    return schema;
  }
  // Genspark's web_search tool, for chat questions that need facts from the web. Returns
  // up to 8 results as {title, snippet, url}; null when the tool is not available.
  async webSearch(key, query) {
    this.toolLists ||= new Map();
    let cached = this.toolLists.get(key);
    if (!cached || cached.until < Date.now()) {
      const list = await this.request('tools', key, undefined, { timeout: 20000 });
      cached = { tools: list?.tools || [], until: Date.now() + 600000 };
      this.toolLists.set(key, cached);
    }
    const tool = cached.tools.find((t) => t?.name === 'web_search');
    if (!tool) return null;
    const names = Object.keys(tool.parameters?.properties || {});
    const param = ['q', 'query', 'queries'].find((n) => names.includes(n)) || names[0] || 'q';
    const type = tool.parameters?.properties?.[param]?.type;
    const data = await this.request(
      'web_search',
      key,
      { [param]: type === 'array' ? [query] : query },
      { ndjson: true, timeout: 45000 },
    );
    const found = [];
    const walk = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 6 || found.length >= 8) return;
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
      const title = v.title || v.name,
        snippet = v.snippet || v.description || v.content || v.summary || v.text,
        url = v.link || v.url;
      if (typeof title === 'string' && typeof snippet === 'string')
        found.push({
          title: title.slice(0, 200),
          snippet: snippet.slice(0, 900),
          url: typeof url === 'string' ? url.slice(0, 300) : undefined,
        });
      else Object.values(v).forEach((x) => walk(x, depth + 1));
    };
    walk(data, 0);
    return found.length ? found : JSON.stringify(data ?? '').slice(0, 6000) || null;
  }
  async run(task, payload, key, setting) {
    if (task === 'image') {
      const model = setting.imageModel || defaultImageModel;
      let schema = null;
      try {
        schema = await this.imageSchema(key);
      } catch {}
      if (schema?.models.length)
        requireThat(
          schema.models.includes(model),
          `Gensparkでは画像モデル「${model}」を現在使えません。管理者設定の画像モデルを変更してください（利用可能：${schema.models.filter((m) => m.includes('gpt-image')).join('、') || schema.models.slice(0, 8).join('、')}）`,
          400,
        );
      const data = await this.request(
        'image_generation',
        key,
        {
          query: `${setting.imagePrompt}\n\n企画内容：\n${JSON.stringify(payload)}\n出力形式はPNG画像。`,
          model,
          aspect_ratio: '16:9',
          image_size: premiumImage.test(model)
            ? !schema?.sizes.length || schema.sizes.includes('2k') ? '2k' : 'auto'
            : !schema?.sizes.length || schema.sizes.includes('1k') ? '1k' : 'auto',
          ...(premiumImage.test(model) && (!schema?.tiers.length || schema.tiers.includes('flare'))
            ? { tier: 'flare' }
            : {}),
        },
        { ndjson: true, timeout: 300000 },
      );
      const url = data?.generated_images?.[0]?.image_urls?.[0];
      requireThat(typeof url === 'string', 'Gensparkから画像が返りませんでした', 502);
      const allowed = [
        'genspark.ai',
        'gensparksite.com',
        'gensparkspace.com',
        'genaicdn.com',
        'gensparkpublicblob.blob.core.windows.net',
      ];
      const check = (u) =>
        requireThat(
          u.protocol === 'https:' &&
            (allowed.some((h) => u.hostname === h || u.hostname.endsWith('.' + h)) ||
              u.hostname.endsWith('.blob.core.windows.net')) &&
            !u.username &&
            !u.password,
          `Gensparkの画像URLを確認してください（${u.hostname}）`,
          502,
        );
      // A file wrapper link (/api/files/…) answers 403 by itself. Like the official CLI's
      // `gsk download`, ask file/download for the real, signed download address first.
      let imageUrl = new URL(url, origin),
        image;
      if (imageUrl.pathname.includes('/api/files/') && !imageUrl.searchParams.has('token')) {
        try {
          const resolved = await this.request(
            'file/download',
            key,
            { file_wrapper_url: url },
            { ndjson: true, timeout: 30000 },
          );
          const direct = (resolved?.data || resolved)?.download_url;
          if (typeof direct === 'string') imageUrl = new URL(direct, origin);
        } catch {}
      }
      // Follow at most 3 redirects, each checked against the same host list.
      for (let hop = 0; ; hop++) {
        check(imageUrl);
        // Genspark's own file links answer 403 without the account's key; the storage and
        // CDN hosts get no credentials.
        const own = imageUrl.hostname === 'genspark.ai' || imageUrl.hostname.endsWith('.genspark.ai');
        image = await this.transport(imageUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(30000),
          headers: {
            Accept: 'image/*',
            'User-Agent': 'Mozilla/5.0 (compatible; WorkshopIdeaDeck)',
            ...(own ? { 'X-Api-Key': key, ...(await this.admission(key)) } : {}),
          },
        });
        const next = image.headers?.get?.('location');
        if (image.status >= 300 && image.status < 400 && next && hop < 3) {
          imageUrl = new URL(next, imageUrl);
          continue;
        }
        break;
      }
      requireThat(
        image.ok,
        `生成画像を取得できませんでした（${image.status}・${imageUrl.hostname}）`,
        502,
      );
      const bytes = Buffer.from(await image.arrayBuffer());
      requireThat(bytes.length <= 8 * 1024 * 1024, '生成画像が大きすぎます', 502);
      // Genspark may hand back JPEG or WebP. PNG is stored as is; other formats are
      // previewed and converted to PNG in the browser when the team applies them.
      const mime = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        ? 'image/png'
        : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
          ? 'image/jpeg'
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
            ? 'image/webp'
            : null;
      requireThat(mime, 'Gensparkから対応していない形式の画像が返りました', 502);
      return mime === 'image/png'
        ? { pngBase64: bytes.toString('base64') }
        : { imageBase64: bytes.toString('base64'), mime };
    }
    if (task === 'transcribe') {
      const format = audioType(payload.mimeType);
      requireThat(format.extension, '対応していない録音形式です');
      // Follow the official CLI's get-upload-url + private blob upload contract.
      const upload = await this.request(
        'file/upload_url',
        key,
        {
          content_type: payload.mimeType,
          name: `discussion.${format.extension}`,
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
      const wrapper = new URL(url, origin);
      requireThat(wrapper.origin === origin, 'Gensparkの録音URLを確認してください', 502);
      const data = await this.request(
        'audio_transcribe',
        key,
        {
          audio_urls: [wrapper.href],
          model: 'gemini-3-flash-preview',
          prompt:
            '日本語のアイデアワークショップの会話です。聞こえた発話を日本語で正確に文字起こししてください。無音や認識不能な箇所に内容を補わないでください。',
        },
        { ndjson: true, envelope: true },
      );
      const text = extractTranscript(data);
      requireThat(
        text.trim(),
        'Gensparkの認識結果に文字が含まれていませんでした。録音を保存・再送できます。マイクの入力レベルも確認してください',
        502,
      );
      return { text };
    }
    return this.text(task, payload, key, setting);
  }
}
