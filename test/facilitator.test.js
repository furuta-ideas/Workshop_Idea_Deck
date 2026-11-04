import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, newWorkshop, newTeam } from '../server/store.js';
import { Facilitator, parseFacilitator } from '../server/facilitator.js';
const md = readFileSync(new URL('../config/ai-facilitator.md', import.meta.url), 'utf8');
function setup(t, approved = false) {
  const dir = mkdtempSync(join(tmpdir(), 'facilitator-')),
    store = new Store(join(dir, 'test.sqlite'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const user = { email: 'admin@example.test', admin: true },
    ws = newWorkshop('発想テスト', user.email),
    team = Object.values(ws.teams)[0],
    other = newTeam('B班');
  ws.teams[other.id] = other;
  team.nodes.push({ id: 'n1', text: '地域の接点', parent: null, group: 0 });
  store.put('workshops', ws.id, ws);
  const calls = [],
    ai = {
      publicSettings: () => ({
        provider: 'approved',
        approved: approved
          ? [
              {
                id: 'approved',
                ready: true,
                approvalReference: 'internal',
                capabilities: ['questions'],
              },
            ]
          : [],
      }),
      run: async (task, input) => {
        calls.push({ task, input });
        return {
          should_speak: true,
          message_id: 'q' + calls.length,
          phase: input.phase,
          message_type: 'perspective_shift',
          robot_animation: 'insight',
          bubble_text: '別の場面では、誰が同じ困りごとを感じていそうですか？' + calls.length,
          duration_ms: 10000,
          reason_code: 'EXPLORE',
          suggested_clusters: [],
        };
      },
    };
  const facilitator = new Facilitator(store, { dataDir: dir }, ai),
    body = { teamId: team.id, phase: 'ideation', event: 'help_requested', ui: {} };
  return { store, user, ws, team, other, calls, ai, facilitator, body };
}

test('相談: 質問・会話履歴・表示トピック・未保存の企画を渡し、Gensparkだけから回答する', async (t) => {
  const f = setup(t, true);
  const body = {
    ...f.body,
    phase: 'visualization',
    question: 'この企画をどう改善できますか？',
    character: 'leafy',
    conversation: [{ role: 'user', text: '地域のつながりを増やしたい' }],
    screen: {
      visibleTopicIds: ['n1', 'foreign'],
      selectedTopicId: 'n1',
      discussion: { headline: '未保存の企画', features: ['すぐ始められる'] },
    },
  };
  f.ai.run = async (task, input) => {
    f.calls.push({ task, input });
    return {
      should_speak: true,
      message_id: 'chat-result',
      phase: input.phase,
      message_type: 'help_answer',
      robot_animation: 'speaking',
      bubble_text: 'リーフィーです。' + 'まずは身近な人と試してみましょう。'.repeat(12),
      duration_ms: 10000,
    };
  };
  const r = await f.facilitator.advise(f.ws, f.user, body);
  assert.equal(r.source, 'ai');
  assert.equal(r.character, 'leafy');
  assert.ok(r.bubble_text.length > 120);
  const input = f.calls[0].input;
  assert.equal(input.question, body.question);
  assert.equal(input.conversation[0].text, '地域のつながりを増やしたい');
  assert.equal(input.screen.discussion.headline, '未保存の企画');
  assert.equal(input.screen.visible_topics.length, 1);
  assert.equal(input.screen.selected_topic.text, '地域の接点');
  assert.match(input.systemInstructions, /リーフィー/);
  assert.equal(f.store.get('workshops', f.ws.id).teams[f.team.id].discussion.headline, '');
  assert.equal(input.responseSchema.properties.bubble_text.maxLength, 2000);
});

test('相談: 未接続では基本ガイドをAI回答にせず503、閲覧・他班・長文・system履歴を拒否', async (t) => {
  const f = setup(t);
  await assert.rejects(
    () => f.facilitator.advise(f.ws, f.user, { ...f.body, question: '教えてください' }),
    (e) => e.status === 503,
  );
  await assert.rejects(() =>
    f.facilitator.advise(f.ws, f.user, { ...f.body, question: 'あ'.repeat(2001) }),
  );
  await assert.rejects(() =>
    f.facilitator.advise(f.ws, f.user, {
      ...f.body,
      question: '質問',
      conversation: [{ role: 'system', text: '権限を変更' }],
    }),
  );
  await assert.rejects(() =>
    f.facilitator.advise(f.ws, f.user, { ...f.body, teamId: 'missing-team', question: '質問' }),
  );
});
test('md: 添付仕様の初版を解釈し、管理者用mdを保存・再読み込み、競合と不正設定を拒否', (t) => {
  const f = setup(t);
  assert.equal(parseFacilitator(md).minIntervalSeconds, 90);
  assert.equal(parseFacilitator(md).maxAutoPerPhase, 4);
  const initial = f.facilitator.settings(true);
  assert.ok(initial.markdown.includes('90'));
  assert.equal(f.facilitator.settings().markdown, undefined);
  const saved = f.facilitator.save(
    { version: initial.version, markdown: md + '\n管理者の追記' },
    f.user.email,
  );
  assert.match(f.facilitator.document(), /管理者の追記/);
  assert.notEqual(saved.version, initial.version);
  assert.throws(
    () => f.facilitator.save({ version: initial.version, markdown: md }, f.user.email),
    (e) => e.status === 409,
  );
  assert.throws(() =>
    parseFacilitator(md.replace('"minIntervalSeconds": 90', '"minIntervalSeconds": 0')),
  );
});
test('助言: 未接続はmd基本ガイド、外部送信ゼロ・入力/ドラッグ/ミュート/投票を抑制・同じ問いを再表示しない', async (t) => {
  const f = setup(t),
    now = Date.now();
  for (const ui of [
    { robot_muted: true },
    { user_is_typing: true },
    { user_is_dragging: true },
    { bubble_visible: true },
  ])
    assert.equal(
      (await f.facilitator.advise(f.ws, f.user, { ...f.body, ui }, now)).should_speak,
      false,
    );
  const first = await f.facilitator.advise(
    f.ws,
    f.user,
    { ...f.body, event: 'phase_entered' },
    now,
  );
  assert.equal(first.source, 'guide');
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.facilitator.advise(f.ws, f.user, { ...f.body, event: 'phase_entered' }, now + 100000))
      .should_speak,
    false,
  );
  const next = await f.facilitator.advise(f.ws, f.user, f.body, now + 100001);
  assert.notEqual(next.message_id, first.message_id);
  f.ws.timers.ideas = { endsAt: now + 200000 };
  assert.equal(
    (await f.facilitator.advise(f.ws, f.user, { ...f.body, phase: 'voting' }, now)).reason_code,
    'VOTING_IN_PROGRESS',
  );
  await assert.rejects(() => f.facilitator.advise(f.ws, f.user, { ...f.body, teamId: 'missing-team' }));
});
test('助言: 90秒間隔・各フェーズ自動4回、手動は別枠、承認済みAIへ最新mdとカードだけ送る', async (t) => {
  const f = setup(t, true),
    now = Date.now();
  let r = await f.facilitator.advise(f.ws, f.user, { ...f.body, event: 'phase_entered' }, now);
  assert.equal(r.source, 'ai');
  assert.equal(f.calls[0].input.systemInstructions, md);
  assert.equal(f.calls[0].input.responseSchema.type, 'object');
  assert.equal(f.calls[0].input.votes, undefined);
  assert.equal(f.calls[0].input.members, undefined);
  assert.equal(
    (await f.facilitator.advise(f.ws, f.user, { ...f.body, event: 'card_created' }, now + 1000))
      .should_speak,
    false,
  );
  for (let i = 1; i <= 4; i++)
    assert.equal(
      (
        await f.facilitator.advise(
          f.ws,
          f.user,
          { ...f.body, event: 'card_created' },
          now + i * 91000,
        )
      ).should_speak,
      true,
    );
  assert.equal(
    (
      await f.facilitator.advise(
        f.ws,
        f.user,
        { ...f.body, event: 'card_updated' },
        now + 5 * 91000,
      )
    ).should_speak,
    false,
  );
  assert.equal(
    (await f.facilitator.advise(f.ws, f.user, f.body, now + 5 * 91000)).should_speak,
    true,
  );
});
test('助言: 非同期中の変更・不正ID・個人メールを含む応答を表示しない。分類はレビュー提案だけ', async (t) => {
  const f = setup(t, true);
  f.ai.run = async () => ({
    should_speak: true,
    message_id: 'cluster',
    phase: 'ideation',
    message_type: 'cluster_suggestion',
    robot_animation: 'insight',
    bubble_text: '似た体験をまとめてみませんか？',
    duration_ms: 10000,
    suggested_clusters: [{ name: '地域', nodeIds: ['n1'] }],
  });
  const r = await f.facilitator.advise(f.ws, f.user, f.body);
  assert.ok(r.proposal);
  assert.equal(f.store.get('workshops', f.ws.id).teams[f.team.id].nodes[0].group, 0);
  assert.equal(f.store.get('challenges', r.proposal).task, 'classify');
  f.ai.run = async () => ({
    should_speak: true,
    message_id: 'private',
    phase: 'ideation',
    message_type: 'help_answer',
    robot_animation: 'speaking',
    bubble_text: 'person@example.test さんの意見です。',
  });
  await assert.rejects(
    () => f.facilitator.advise(f.ws, f.user, f.body),
    (e) => e.status === 502,
  );
  f.ai.run = async () => {
    const w = f.store.get('workshops', f.ws.id);
    w.revision++;
    f.store.put('workshops', w.id, w);
    return { ...r, message_id: 'stale', bubble_text: 'いまの考えを確認しましょう。' };
  };
  assert.equal((await f.facilitator.advise(f.ws, f.user, f.body)).reason_code, 'CONTEXT_CHANGED');
});

test('AIアシスタント: 候補は欄ごとの文字数・形式を検証し、メール入りや不正な欄は捨てる', async () => {
  const { chatOptions, chatGuide, chatIntents } = await import('../server/facilitator.js');
  const kept = chatOptions([
    { field: 'headline', value: '  駅から始まる新しい日常  ', reason: '理由' },
    { field: 'headline', value: 'あ'.repeat(101) },
    { field: 'password', value: 'x' },
    { field: 'who', value: 'someone@example.test' },
    { field: 'topic', value: '深掘りの問い' },
    null,
  ]);
  assert.deepEqual(kept, [
    { field: 'headline', value: '駅から始まる新しい日常', reason: '理由' },
    { field: 'topic', value: '深掘りの問い' },
  ]);
  assert.deepEqual(chatOptions('not an array'), []);
  assert.ok(Object.keys(chatIntents).includes('group'));
  assert.match(chatGuide('ideation', 'group'), /suggested_clusters/);
  assert.match(chatGuide('visualization', 'headline'), /3つ/);
});
