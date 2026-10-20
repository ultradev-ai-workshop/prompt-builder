/**
 * Prompt builder engine — shared by the browser UI and the Node API.
 *
 * Structure follows proven prompt-engineering practice:
 *   Role → Context → Task → Focus → Requirements → Approach → Examples → Output → Success criteria
 * Each section is optional and only rendered when it has content.
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

  /** Collect the logical sections of the prompt from the current state. */
  function buildSections(state, data) {
    const { roles = [], options = {} } = data;
    const experts = pickMany(roles, roleIdsOf(state));
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
    if (stack.length) ctx.push({ lead: 'Tech stack / environment:', items: stack });
    if (audience) ctx.push(audience.instruction);
    if (ctx.length) sections.push({ key: 'context', title: 'Context', parts: ctx });

    const taskParts = [];
    if (task) taskParts.push(task.instruction);
    if (clean(state.description)) taskParts.push({ quote: clean(state.description) });
    if (taskParts.length) sections.push({ key: 'task', title: 'Task', parts: taskParts });

    if (state.focusAreas?.length) {
      sections.push({ key: 'focus', title: 'Focus Areas', parts: [{ lead: 'Pay particular attention to:', items: state.focusAreas }] });
    }

    const reqs = [...constraints.map((c) => c.instruction), ...splitLines(state.customConstraints)];
    if (reqs.length) sections.push({ key: 'requirements', title: 'Requirements & Constraints', parts: [{ items: reqs }] });

    if (reasoning.length) {
      sections.push({ key: 'approach', title: 'Approach', parts: [{ items: reasoning.map((r) => r.instruction), ordered: true }] });
    }

    const expertIds = roleIdsOf(state);
    const reviewers = pickMany(roles, (state.reviewerIds || []).filter((id) => !expertIds.includes(id)));
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

  /** Heuristic prompt-quality analysis with actionable tips. */
  function analyze(state) {
    const checks = [
      { ok: roleIdsOf(state).length > 0, weight: 15, tip: 'Pick at least one expert role so the model adopts the right expertise.' },
      { ok: clean(state.description).length >= 40, weight: 25, tip: 'Describe the task in more detail (40+ characters): what, why and any specifics.' },
      { ok: !!state.taskType, weight: 10, tip: 'Choose a task type to frame what kind of work is expected.' },
      { ok: clean(state.context).length > 0 || (state.techStack || []).length > 0 || clean(state.customStack).length > 0, weight: 10, tip: 'Add background context or a tech stack.' },
      { ok: (state.constraints || []).length > 0 || clean(state.customConstraints).length > 0, weight: 10, tip: 'Add requirements/constraints so the output fits your standards.' },
      { ok: (state.outputFormats || []).length > 0, weight: 10, tip: 'Specify an output format.' },
      { ok: splitLines(state.successCriteria).length > 0, weight: 10, tip: 'Define success criteria: how will you judge a good answer?' },
      { ok: (state.reasoning || []).length > 0, weight: 5, tip: 'Add an approach (e.g. state assumptions, self-review).' },
      { ok: (state.focusAreas || []).length > 0, weight: 5, tip: 'Select focus areas to prioritise what matters most.' }
    ];
    const score = checks.reduce((acc, c) => acc + (c.ok ? c.weight : 0), 0);
    return { score, tips: checks.filter((c) => !c.ok).map((c) => c.tip) };
  }

  /** Rough token estimate (~4 chars per token for English text). */
  const estimateTokens = (text) => Math.ceil((text || '').length / 4);

  return { build, buildSections, analyze, estimateTokens };
});
