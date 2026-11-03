import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, id } from './store.js';
import { requireThat, access, teamFor } from './domain.js';

export const phases = ['ideation', 'selection', 'visualization', 'voting'];
const animations = [
  'idle',
  'observing',
  'thinking',
  'speaking',
  'insight',
  'celebrating',
  'warning',
  'muted',
];
const messageTypes = [
  'intro',
  'encouragement',
  'perspective_shift',
  'problem_clarification',
  'cluster_suggestion',
  'must_have_check',
  'social_impact_check',
  'payer_check',
  'prioritization',
  'wow_check',
  'headline_prompt',
  'visualization_feedback',
  'investment_question',
  'commitment_question',
  'voting_reflection',
  'phase_transition',
  'help_answer',
];
export const adviceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'should_speak',
    'message_id',
    'phase',
    'message_type',
    'robot_animation',
    'bubble_text',
    'duration_ms',
    'reason_code',
  ],
  properties: {
    should_speak: { type: 'boolean' },
    message_id: { type: 'string', maxLength: 100 },
    phase: { enum: phases },
    message_type: { enum: messageTypes },
    robot_animation: { enum: animations },
    bubble_text: { type: 'string', maxLength: 120 },
    duration_ms: { type: 'integer', minimum: 6000, maximum: 12000 },
    reason_code: { type: 'string', maxLength: 100 },
    confidence: { enum: ['low', 'medium', 'high'] },
    priority: { enum: ['low', 'medium', 'high'] },
    target_card_ids: { type: 'array', items: { type: 'string' } },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { enum: ['dismiss', 'later', 'more', 'focus', 'preview_clusters'] },
          label: { type: 'string', maxLength: 30 },
          type: { type: 'string' },
        },
      },
    },
    suggested_clusters: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        required: ['name', 'nodeIds'],
        properties: {
          name: { type: 'string', maxLength: 80 },
          nodeIds: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string', maxLength: 200 },
        },
      },
    },
  },
};
export function parseFacilitator(markdown) {
  requireThat(
    typeof markdown === 'string' && markdown.length >= 200 && markdown.length <= 120000,
    'mdは200〜120000文字で設定してください',
  );
  const match = /```facilitator-config\s*([\s\S]*?)```/.exec(markdown);
  requireThat(match, '先頭のfacilitator-config設定を保持してください');
  let policy;
  try {
    policy = JSON.parse(match[1]);
  } catch {
    requireThat(false, 'facilitator-configのJSONを確認してください');
  }
  requireThat(typeof policy.autoIntervention === 'boolean', '自動介入の設定を確認してください');
  for (const [key, min, max] of [
    ['minIntervalSeconds', 30, 3600],
    ['maxAutoPerPhase', 0, 12],
    ['idleSeconds', 30, 3600],
    ['stagnationSeconds', 30, 3600],
  ])
    requireThat(
      Number.isInteger(policy[key]) && policy[key] >= min && policy[key] <= max,
      `${key}の範囲を確認してください`,
    );
  for (const phase of phases) {
    const messages = policy.phaseMessages?.[phase];
    requireThat(
      Array.isArray(messages) && messages.length >= 1 && messages.length <= 30,
      `${phase}の基本ガイドが必要です`,
    );
    const ids = new Set();
    for (const m of messages) {
      requireThat(
        typeof m.id === 'string' &&
          m.id.length <= 100 &&
          !ids.has(m.id) &&
          typeof m.text === 'string' &&
          m.text.trim() &&
          [...m.text].length <= 120 &&
          animations.includes(m.animation),
        'ガイドのID・120文字以内の本文・状態を確認してください',
      );
      ids.add(m.id);
    }
  }
  return policy;
}
export class Facilitator {
  constructor(store, config, ai) {
    this.store = store;
    this.ai = ai;
    this.file = join(config.dataDir, 'ai-facilitator.md');
    this.defaultFile = fileURLToPath(new URL('../config/ai-facilitator.md', import.meta.url));
    if (!existsSync(this.file)) writeFileSync(this.file, readFileSync(this.defaultFile));
  }
  document() {
    return readFileSync(this.file, 'utf8');
  }
  settings(admin = false) {
    const markdown = this.document();
    return {
      version: hash(markdown),
      policy: parseFacilitator(markdown),
      ...(admin ? { markdown } : {}),
    };
  }
  save(body, actor) {
    const current = this.settings();
    requireThat(
      body.version === current.version,
      '別の管理者がmdを変更しました。読み直して確認してください',
      409,
    );
    parseFacilitator(body.markdown);
    const temp = this.file + '.tmp';
    writeFileSync(temp, body.markdown);
    renameSync(temp, this.file);
    this.store.audit('facilitator-config', { actor: hash(actor), version: hash(body.markdown) });
    return this.settings(true);
  }
  async advise(ws, user, body, now = Date.now()) {
    access(this.store, ws, user, true, now);
    const team = teamFor(ws, user, body.teamId);
    requireThat(phases.includes(body.phase), 'フェーズが不正です');
    const settings = this.settings(),
      p = settings.policy,
      manual = body.event === 'help_requested';
    const key = `facilitator:${ws.id}:${team.id}:${hash(user.email)}:${body.phase}`;
    const state = this.store.get('kv', key) || {
      autoCount: 0,
      seen: [],
      introduced: false,
      lastAttemptAt: 0,
      lastChangedAt: now,
    };
    const quiet = (reason) => ({ should_speak: false, reason_code: reason, source: 'none' });
    if (state.version !== settings.version) {
      state.version = settings.version;
      state.seen = [];
      state.texts = [];
      state.introduced = false;
    }
    const ui = body.ui || {};
    if (ui.robot_muted) return quiet('MUTED');
    if (ui.user_is_typing || ui.user_is_dragging || ui.bubble_visible) return quiet('USER_BUSY');
    const timer =
      body.phase === 'selection'
        ? ws.timers.cards
        : body.phase === 'voting'
          ? ws.timers.ideas
          : null;
    const voting = timer && !timer.closed && timer.endsAt > now;
    if (voting) return quiet('VOTING_IN_PROGRESS');
    if (!manual && !p.autoIntervention) return quiet('AUTO_DISABLED');
    if (state.pendingUntil > now) return quiet('THINKING');
    const intro = body.event === 'phase_entered' && !state.introduced;
    if (
      !manual &&
      !intro &&
      (now - state.lastAttemptAt < p.minIntervalSeconds * 1000 ||
        state.autoCount >= p.maxAutoPerPhase)
    )
      return quiet('COOLDOWN');
    if (body.event === 'phase_entered' && state.introduced) return quiet('DUPLICATE');
    if (body.event === 'timer_tick') {
      const elapsed = now - (Number(body.enteredAt) || now);
      const stagnant = now - (Number(body.lastChangedAt) || now);
      if (
        !(
          (body.phase === 'ideation' &&
            team.nodes.length === 0 &&
            elapsed >= p.idleSeconds * 1000) ||
          stagnant >= p.stagnationSeconds * 1000
        )
      )
        return quiet('NO_USEFUL_INSIGHT');
    }
    if (
      ![
        'help_requested',
        'phase_entered',
        'timer_tick',
        'card_created',
        'card_updated',
        'card_deleted',
        'card_moved',
        'card_shortlisted',
        'visualization_updated',
        'phase_exit_requested',
      ].includes(body.event)
    )
      return quiet('NO_USEFUL_INSIGHT');
    state.lastAttemptAt = now;
    state.pendingUntil = now + 95000;
    this.store.put('kv', key, state);
    try {
      const available = this.ai.publicSettings();
      const ready = available.approved.some(
        (x) =>
          x.id === available.provider &&
          x.ready &&
          x.approvalReference &&
          x.capabilities.includes('questions'),
      );
      let result, source;
      if (ready) {
        source = 'ai';
        result = await this.ai.run(
          'questions',
          {
            mode: 'facilitation',
            systemInstructions: this.document(),
            responseSchema: adviceSchema,
            phase: body.phase,
            event: body.event,
            session_id: ws.id,
            theme: team.rootText || ws.theme,
            cards: team.nodes.map((n) => ({ id: n.id, text: n.text, cluster_id: n.group })),
            selected_card_ids: team.deck,
            discussion: team.discussion,
            recent_ai_message_ids: state.seen,
            ui: { ...ui, voting_in_progress: !!voting },
            settings: {
              min_interval_seconds: p.minIntervalSeconds,
              max_auto_interventions_per_phase: p.maxAutoPerPhase,
            },
          },
          user.email,
        );
      } else {
        source = 'guide';
        const message = p.phaseMessages[body.phase].find((m) => !state.seen.includes(m.id));
        if (!message) return quiet('DUPLICATE');
        result = {
          should_speak: true,
          message_id: message.id,
          phase: body.phase,
          message_type: intro ? 'intro' : 'perspective_shift',
          robot_animation: message.animation,
          bubble_text: message.text,
          duration_ms: 10000,
          reason_code: 'MD_BASIC_GUIDE',
          suggested_clusters: [],
        };
      }
      requireThat(typeof result?.should_speak === 'boolean', 'AI助言のJSON形式が不正です', 502);
      if (!result.should_speak) return quiet(result.reason_code || 'NO_USEFUL_INSIGHT');
      requireThat(
        !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(result.bubble_text || ''),
        '個人のメールアドレスを含む助言は表示できません',
        502,
      );
      requireThat(
        result.phase === body.phase &&
          typeof result.message_id === 'string' &&
          result.message_id.length <= 100 &&
          typeof result.bubble_text === 'string' &&
          result.bubble_text.trim() &&
          [...result.bubble_text].length <= 120 &&
          animations.includes(result.robot_animation) &&
          messageTypes.includes(result.message_type),
        'AI助言の本文・フェーズ・状態を確認できません',
        502,
      );
      if (state.seen.includes(result.message_id) || state.texts?.includes(hash(result.bubble_text)))
        return quiet('DUPLICATE');
      const latest = this.store.get('workshops', ws.id);
      access(this.store, latest, user, true);
      teamFor(latest, user, team.id);
      if (latest.revision !== ws.revision) return quiet('CONTEXT_CHANGED');
      const groups = result.suggested_clusters || [];
      requireThat(Array.isArray(groups) && groups.length <= 8, '分類提案の形式が不正です', 502);
      const seen = new Set();
      for (const g of groups) {
        requireThat(
          typeof g.name === 'string' && g.name.length <= 80 && Array.isArray(g.nodeIds),
          '分類提案を確認できません',
          502,
        );
        for (const nodeId of g.nodeIds) {
          requireThat(
            !seen.has(nodeId) && team.nodes.some((n) => n.id === nodeId),
            '分類先のカードが不正です',
            502,
          );
          seen.add(nodeId);
        }
      }
      let proposal;
      if (groups.length) {
        proposal = id();
        this.store.put('challenges', proposal, {
          type: 'ai',
          email: user.email,
          wsId: ws.id,
          teamId: team.id,
          revision: ws.revision,
          task: 'classify',
          result: { groups },
          expires: now + 600000,
        });
      }
      state.introduced = true;
      if (!manual && !intro) state.autoCount++;
      state.seen.push(result.message_id);
      state.texts = [...(state.texts || []), hash(result.bubble_text)].slice(-100);
      state.seen = state.seen.slice(-100);
      this.store.audit('facilitator-shown', {
        wsId: ws.id,
        teamId: team.id,
        phase: body.phase,
        id: result.message_id,
        source,
        actor: hash(user.email),
      });
      return {
        should_speak: true,
        source,
        version: settings.version,
        message_id: result.message_id,
        phase: body.phase,
        message_type: result.message_type,
        robot_animation: result.robot_animation,
        bubble_text: result.bubble_text,
        duration_ms: Math.max(6000, Math.min(12000, Number(result.duration_ms) || 10000)),
        suggested_clusters: groups,
        proposal,
      };
    } finally {
      state.pendingUntil = 0;
      this.store.put('kv', key, state);
    }
  }
  feedback(ws, user, body) {
    access(this.store, ws, user);
    requireThat(
      ['dismiss', 'later', 'accepted'].includes(body.action) &&
        typeof body.messageId === 'string' &&
        body.messageId.length < 100,
      '操作を確認してください',
    );
    this.store.audit('facilitator-feedback', {
      wsId: ws.id,
      phase: body.phase,
      id: body.messageId,
      action: body.action,
      actor: hash(user.email),
    });
    return { ok: true };
  }
}
