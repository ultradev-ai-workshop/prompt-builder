/**
 * Prompt builder engine — shared by the browser UI and the Node API.
 *
 * Structure follows proven prompt-engineering practice:
 *   Role → Context → Task → Focus → Patterns → Requirements → Guardrails → Approach → Examples → Output → Success criteria
 * Each section is optional and only rendered when it has content.
 * Options tagged with `professions` belong to those professions; untagged options are shared.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PromptBuilder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const byId = (list, id) => (list || []).find((x) => x.id === id);
  const pickMany = (list, ids) => (ids || []).map((id) => byId(list, id)).filter(Boolean);
  const clean = (s) => (s || '').trim();
  /** Expert role ids; also accepts the older single `roleId` field. */
  const roleIdsOf = (state) => (Array.isArray(state.roleIds) && state.roleIds.length ? state.roleIds : state.roleId ? [state.roleId] : []);
  const DEFAULT_PROFESSION = 'software';
  const professionOf = (role) => role.profession || DEFAULT_PROFESSION;

  /** Items of an option list that apply to a profession (untagged items apply to all). */
  const forProfession = (list, professionId) =>
    (list || []).filter((x) => !x.professions || x.professions.includes(professionId || DEFAULT_PROFESSION));

  /** Expert roles followed by reviewer roles (never both for one role). */
  function selectedRoles(state, roles) {
    const expertIds = roleIdsOf(state);
    return {
      experts: pickMany(roles, expertIds),
      reviewers: pickMany(roles, (state.reviewerIds || []).filter((id) => !expertIds.includes(id)))
    };
  }

  /**
   * Guardrails for every profession represented by the selected roles
   * (or the active profession when no role is selected). Empty when switched off.
   */
  function guardrailsFor(state, data) {
    if (state.guardrails === false) return [];
    const { experts, reviewers } = selectedRoles(state, data.roles);
    const ids = [...experts, ...reviewers].map(professionOf);
    if (!ids.length) ids.push(state.profession || DEFAULT_PROFESSION);
    const professions = pickMany(data.options?.professions, [...new Set(ids)]);
    return [...new Set(professions.flatMap((p) => p.guardrails || []))];
  }

  /** Collect the logical sections of the prompt from the current state. */
  function buildSections(state, data) {
    const { roles = [], options = {} } = data;
    const { experts, reviewers } = selectedRoles(state, roles);
    const profession = byId(options.professions, state.profession || DEFAULT_PROFESSION);
    const task = byId(options.taskTypes, state.taskType);
    const audience = byId(options.audiences, state.audience);
    const tone = byId(options.tones, state.tone);
    const length = byId(options.lengths, state.length);
    const formats = pickMany(options.outputFormats, state.outputFormats);
    const constraints = pickMany(options.constraints, state.constraints);
    const reasoning = pickMany(options.reasoning, state.reasoning);
    const stack = [...(state.techStack || []), ...splitList(state.customStack)];

    const sections = [];

    if (experts.length === 1) {
      const [role] = experts;
      const parts = [role.persona];
      if (role.expertise?.length) parts.push({ lead: 'Your core expertise includes:', items: role.expertise });
      if (role.principles?.length) parts.push({ lead: 'You work by these principles:', items: role.principles });
      sections.push({ key: 'role', title: 'Role', parts });
    } else if (experts.length > 1) {
      const parts = [
        `You are a team of senior experts working together on this task: ${experts.map((r) => r.title).join(', ')}. ` +
          'Apply the knowledge and standards of every expert. Where their priorities conflict, make the trade-off explicit and justify your choice.'
      ];
      for (const r of experts) {
        const items = [];
        if (r.expertise?.length) items.push(`Expertise: ${r.expertise.join('; ')}`);
        if (r.principles?.length) items.push(`Principles: ${r.principles.join('; ')}`);
        parts.push(items.length ? { lead: `${r.title}: ${r.description}`, items } : `${r.title}: ${r.description}`);
      }
      sections.push({ key: 'role', title: 'Roles', parts });
    }

    const ctx = [];
    if (clean(state.context)) ctx.push(clean(state.context));
    if (stack.length) ctx.push({ lead: profession?.contextLead || 'Tech stack / environment:', items: stack });
    if (audience) ctx.push(audience.instruction);
    if (ctx.length) sections.push({ key: 'context', title: 'Context', parts: ctx });

    const taskParts = [];
    if (task) taskParts.push(task.instruction);
    if (clean(state.description)) taskParts.push({ quote: clean(state.description) });
    if (taskParts.length) sections.push({ key: 'task', title: 'Task', parts: taskParts });

    if (state.focusAreas?.length) {
      sections.push({ key: 'focus', title: 'Focus Areas', parts: [{ lead: 'Pay particular attention to:', items: state.focusAreas }] });
    }

    if (state.patterns?.length) {
      sections.push({
        key: 'design_patterns',
        title: 'Design Patterns & Implementation Style',
        parts: [
          'Apply the following patterns and implementation styles where they genuinely fit, and show briefly where and how each is applied. If one is a poor fit for this problem, say so and explain why instead of forcing it.',
          { items: state.patterns }
        ]
      });
    }

    const reqs = [...constraints.map((c) => c.instruction), ...splitLines(state.customConstraints)];
    if (reqs.length) sections.push({ key: 'requirements', title: 'Requirements & Constraints', parts: [{ items: reqs }] });

    const guardrails = guardrailsFor(state, data);
    if (guardrails.length) {
      sections.push({ key: 'guardrails', title: 'Safety & Scope', parts: ['Stay within these professional boundaries:', { items: guardrails }] });
    }

    if (reasoning.length) {
      sections.push({ key: 'approach', title: 'Approach', parts: [{ items: reasoning.map((r) => r.instruction), ordered: true }] });
    }

    if (reviewers.length) {
      sections.push({
        key: 'review_perspectives',
        title: 'Review Perspectives',
        parts: [
          'After drafting your answer, critique it from each of the following expert perspectives, then revise it to address their concerns. Briefly note the most important change each review led to.',
          { items: reviewers.map((r) => (r.focusAreas?.length ? `${r.title}, focusing on ${r.focusAreas.slice(0, 4).join(', ').toLowerCase()}` : r.title)) }
        ]
      });
    }

    if (clean(state.examples)) {
      sections.push({ key: 'examples', title: 'Examples', parts: ['Use the following as a reference for the expected style and quality:', { quote: clean(state.examples) }] });
    }

    const out = [...formats.map((f) => f.instruction)];
    if (tone) out.push(tone.instruction);
    if (length && length.instruction) out.push(length.instruction);
    if (out.length) sections.push({ key: 'output_format', title: 'Output Format', parts: [{ items: out }] });

    const criteria = splitLines(state.successCriteria);
    if (criteria.length) {
      sections.push({ key: 'success_criteria', title: 'Success Criteria', parts: ['Your response is successful if:', { items: criteria, checklist: true }] });
    }

    return sections;
  }

  function splitLines(s) {
    return clean(s).split('\n').map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter(Boolean);
  }
  function splitList(s) {
    return clean(s).split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  }

  /* ---------- Renderers ---------- */

  function renderList(p, style) {
    return p.items
      .map((it, i) => {
        if (style === 'plain') return `${p.ordered ? i + 1 + '.' : '-'} ${it}`;
        if (p.checklist && style === 'markdown') return `- [ ] ${it}`;
        return `${p.ordered ? i + 1 + '.' : '-'} ${it}`;
      })
      .join('\n');
  }

  function renderPart(p, style) {
    if (typeof p === 'string') return p;
    if (p.quote) {
      if (style === 'markdown') return p.quote.split('\n').map((l) => `> ${l}`).join('\n');
      if (style === 'xml') return p.quote;
      return `"""\n${p.quote}\n"""`;
    }
    const lead = p.lead ? (style === 'markdown' ? `**${p.lead}**\n` : `${p.lead}\n`) : '';
    return lead + renderList(p, style);
  }

  function render(sections, style) {
    const body = sections.map((s) => {
      const content = s.parts.map((p) => renderPart(p, style)).join('\n\n');
      if (style === 'xml') return `<${s.key}>\n${content}\n</${s.key}>`;
      if (style === 'plain') return `${s.title.toUpperCase()}\n${content}`;
      return `## ${s.title}\n\n${content}`;
    });
    if (!body.length) return '';
    if (style === 'markdown') return `# Prompt\n\n${body.join('\n\n')}\n`;
    return body.join('\n\n') + '\n';
  }

  /** Build the final prompt string. */
  function build(state, data) {
    return render(buildSections(state, data), state.style || 'markdown');
  }

  // Software tasks where naming patterns or an implementation style noticeably improves the answer.
  const PATTERN_TASKS = ['implement', 'design', 'refactor', 'api-design', 'migrate'];

  /** Heuristic prompt-quality analysis with actionable tips. `data` (optional) makes tips profession-aware. */
  function analyze(state, data = {}) {
    const profession = byId(data.options?.professions, state.profession || DEFAULT_PROFESSION);
    const contextName = (profession?.contextTitle || 'a tech stack').toLowerCase();
    const checks = [
      { ok: roleIdsOf(state).length > 0, weight: 15, tip: 'Pick at least one expert role so the model adopts the right expertise.' },
      { ok: clean(state.description).length >= 40, weight: 25, tip: 'Describe the task in more detail (40+ characters): what, why and any specifics.' },
      { ok: !!state.taskType, weight: 10, tip: 'Choose a task type to frame what kind of work is expected.' },
      { ok: clean(state.context).length > 0 || (state.techStack || []).length > 0 || clean(state.customStack).length > 0, weight: 10, tip: `Add background context or ${contextName}.` },
      { ok: (state.constraints || []).length > 0 || clean(state.customConstraints).length > 0, weight: 10, tip: 'Add requirements/constraints so the output fits your standards.' },
      { ok: (state.outputFormats || []).length > 0, weight: 10, tip: 'Specify an output format.' },
      { ok: splitLines(state.successCriteria).length > 0, weight: 10, tip: 'Define success criteria: how will you judge a good answer?' },
      { ok: (state.reasoning || []).length > 0, weight: 5, tip: 'Add an approach (e.g. state assumptions, self-review).' },
      { ok: (state.focusAreas || []).length > 0, weight: 5, tip: 'Select focus areas to prioritise what matters most.' },
      // Advisory only (no weight): nudges software design work towards explicit patterns.
      {
        ok: !PATTERN_TASKS.includes(state.taskType) || (state.patterns || []).length > 0 || (state.reasoning || []).includes('recommend-patterns'),
        weight: 0,
        tip: 'Pick design patterns / an implementation style, or choose “Recommend patterns” under Approach.'
      }
    ];
    const score = checks.reduce((acc, c) => acc + (c.ok ? c.weight : 0), 0);
    return { score, tips: checks.filter((c) => !c.ok).map((c) => c.tip) };
  }

  /** Rough token estimate (~4 chars per token for English text). */
  const estimateTokens = (text) => Math.ceil((text || '').length / 4);

  return { build, buildSections, analyze, estimateTokens, forProfession, guardrailsFor, DEFAULT_PROFESSION };
});
