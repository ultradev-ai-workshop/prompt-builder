/* Prompt Builder: UI controller. Rendering is data-driven from /api/roles and /api/options. */
(() => {
  'use strict';

  const STORAGE = {
    draft: 'pb.draft.v1',
    saved: 'pb.saved.v1',
    customRoles: 'pb.roles.custom.v1',
    activeTemplate: 'pb.activeTemplate',
    theme: 'pb.theme',
    ai: 'pb.ai'
  };
  const MAX_VERSIONS = 20;
  const EXPORT_FORMAT = 'prompt-builder/templates';

  const DEFAULT_STATE = {
    profession: PromptBuilder.DEFAULT_PROFESSION, // filters roles and options; roles from others stay selected
    roleIds: [],      // expert roles, in the order selected
    reviewerIds: [],  // roles that critique the draft
    taskType: null,
    description: '',
    context: '',
    techStack: [],
    customStack: '',
    focusAreas: [],
    patterns: [],     // design pattern / implementation style labels
    constraints: [],
    customConstraints: '',
    reasoning: ['assumptions', 'self-review'],
    outputFormats: ['structured-md'],
    audience: 'self',
    tone: 'concise',
    length: 'any',
    successCriteria: '',
    examples: '',
    guardrails: true, // include the professions' safety & scope rules
    style: 'markdown'
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'on') Object.entries(v).forEach(([evt, fn]) => node.addEventListener(evt, fn));
      else if (k === 'text') node.textContent = v;
      else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
    }
    [].concat(children).forEach((c) => c && node.append(c));
    return node;
  };

  const store = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    }
  };

  /** Keep only known fields with the expected type (stored drafts and imported files are untrusted). */
  function sanitizeState(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    for (const [key, def] of Object.entries(DEFAULT_STATE)) {
      const v = src[key];
      if (Array.isArray(def)) out[key] = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [...def];
      else if (def === null) out[key] = typeof v === 'string' ? v : null;
      else if (typeof def === 'boolean') out[key] = typeof v === 'boolean' ? v : def;
      else out[key] = typeof v === 'string' ? v : def;
    }
    // Older drafts and templates stored a single role as `roleId`.
    if (!out.roleIds.length && typeof src.roleId === 'string') out.roleIds = [src.roleId];
    out.roleIds = [...new Set(out.roleIds)];
    out.reviewerIds = [...new Set(out.reviewerIds)].filter((id) => !out.roleIds.includes(id));
    return out;
  }

  let data = { roles: [], options: {} };
  let builtInRoles = [];
  let state = sanitizeState(store.get(STORAGE.draft, {}));
  let roleFilter = { query: '', category: 'All' };
  let currentPrompt = '';

  /* ---------------- State ---------------- */

  function setState(patch, { rerender = [] } = {}) {
    state = { ...state, ...patch };
    store.set(STORAGE.draft, state);
    rerender.forEach((fn) => fn());
    updateOutput();
  }

  const toggleIn = (arr, value) => (arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]);

  /* ---------------- Professions ---------------- */

  const currentProfession = () => (data.options.professions || []).find((p) => p.id === state.profession);
  /** Option items that apply to the active profession. */
  const visible = (list) => PromptBuilder.forProfession(list, state.profession);
  const professionRoles = () => data.roles.filter((r) => (r.profession || PromptBuilder.DEFAULT_PROFESSION) === state.profession);

  function renderProfessions() {
    $('#professions').replaceChildren(
      ...(data.options.professions || []).map((p) =>
        el('button', {
          type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(state.profession === p.id), title: p.description,
          on: { click: () => setProfession(p.id) }
        }, `${p.icon} ${p.label}`)
      )
    );
    renderProfessionText();
  }

  function renderProfessionText() {
    const p = currentProfession();
    $('#professionDesc').textContent = p?.description || '';
    $('#s3').textContent = p?.contextTitle || 'Tech stack & focus';
    $('#contextHint').textContent = p?.contextHint || '';
    $('#customStackLabel').textContent = p?.customContextLabel || 'Other technologies';
    $('#customStack').placeholder = p?.customContextPlaceholder || '';
    $('#context').placeholder = p?.contextPlaceholder || DEFAULT_CONTEXT_PLACEHOLDER;
    if (p?.constraintsPlaceholder) $('#customConstraints').placeholder = `e.g. ${p.constraintsPlaceholder}`;
    if (p?.successPlaceholder) $('#successCriteria').placeholder = `e.g. ${p.successPlaceholder}`;
  }

  /**
   * Switch profession. Option selections the new profession doesn't offer are dropped so nothing
   * hidden still affects the prompt; selected roles are kept so roles can be combined across professions.
   */
  function setProfession(id) {
    if (id === state.profession) return;
    const o = data.options;
    const ids = (list) => new Set(PromptBuilder.forProfession(list, id).map((x) => x.id));
    const keep = (key, list) => { const ok = ids(list); return state[key].filter((v) => ok.has(v)); };
    const stackItems = new Set(PromptBuilder.forProfession(o.techStack, id).flatMap((g) => g.items));
    const patternItems = new Set(PromptBuilder.forProfession(o.patterns, id).flatMap((g) => g.items.map((it) => it.label)));
    const audiences = ids(o.audiences);
    const profession = o.professions.find((p) => p.id === id);
    roleFilter.category = 'All';
    showAllPatterns = false;
    loadState({
      ...state,
      profession: id,
      taskType: ids(o.taskTypes).has(state.taskType) ? state.taskType : null,
      constraints: keep('constraints', o.constraints),
      reasoning: keep('reasoning', o.reasoning),
      outputFormats: keep('outputFormats', o.outputFormats),
      audience: audiences.has(state.audience) ? state.audience : profession?.defaultAudience || [...audiences][0] || null,
      techStack: state.techStack.filter((t) => stackItems.has(t)),
      patterns: state.patterns.filter((x) => patternItems.has(x))
    });
  }

  /* ---------------- Generic controls ---------------- */

  /** Single-select chips (radio semantics, click again to deselect). */
  function renderRadioChips(container, items, key, { allowNone = true } = {}) {
    container.replaceChildren(
      ...items.map((it) =>
        el('button', {
          type: 'button', class: 'chip', role: 'radio',
          'aria-checked': String(state[key] === it.id),
          title: it.instruction || '',
          on: { click: () => {
            const next = state[key] === it.id && allowNone ? null : it.id;
            setState({ [key]: next }, { rerender: [() => renderRadioChips(container, items, key, { allowNone })] });
          } }
        }, [it.icon ? `${it.icon} ` : '', it.label])
      )
    );
  }

  /** Multi-select chips. Items may be {id,label} objects or plain strings. */
  function renderToggleChips(container, items, key) {
    container.replaceChildren(
      ...items.map((it) => {
        const id = typeof it === 'string' ? it : it.id ?? it.label;
        const label = typeof it === 'string' ? it : it.label;
        return el('button', {
          type: 'button', class: 'chip',
          'aria-pressed': String((state[key] || []).includes(id)),
          title: it.instruction || it.hint || '',
          on: { click: (e) => {
            setState({ [key]: toggleIn(state[key] || [], id) });
            e.currentTarget.setAttribute('aria-pressed', String(state[key].includes(id)));
          } }
        }, label);
      })
    );
  }

  function renderSegmented(container, items, key) {
    container.replaceChildren(
      ...items.map((it) =>
        el('button', {
          type: 'button', role: 'radio', 'aria-checked': String(state[key] === it.id),
          title: it.hint || it.instruction || '',
          on: { click: () => setState({ [key]: it.id }, { rerender: [() => renderSegmented(container, items, key)] }) }
        }, it.label)
      )
    );
  }

  /* ---------------- Roles ---------------- */

  function renderRoleCategories() {
    const cats = ['All', ...new Set(professionRoles().map((r) => r.category))];
    $('#roleCategories').replaceChildren(
      ...cats.map((c) =>
        el('button', {
          type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(roleFilter.category === c),
          on: { click: () => { roleFilter.category = c; renderRoleCategories(); renderRoleGrid(); } }
        }, c)
      )
    );
  }

  function renderRoleGrid() {
    const q = roleFilter.query.toLowerCase();
    const roles = professionRoles().filter((r) =>
      (roleFilter.category === 'All' || r.category === roleFilter.category) &&
      (!q || `${r.title} ${r.description} ${r.expertise.join(' ')}`.toLowerCase().includes(q))
    );
    const cards = roles.map((r) => {
      const reviewer = state.reviewerIds.includes(r.id);
      const selected = reviewer || state.roleIds.includes(r.id);
      return el('button', {
        type: 'button', class: reviewer ? 'role-card is-reviewer' : 'role-card', role: 'checkbox',
        'aria-checked': String(selected), title: r.description,
        on: { click: () => toggleRole(r.id) }
      }, [
        el('span', { class: 'icon', 'aria-hidden': 'true', text: r.icon }),
        el('span', { class: 'title', text: r.title }),
        el('span', { class: 'cat', text: r.category }),
        el('span', { class: 'badges' }, [
          r.custom ? el('span', { class: 'badge', text: 'Custom' }) : null,
          reviewer ? el('span', { class: 'badge badge-reviewer', text: 'Reviewer' }) : null
        ])
      ]);
    });
    if (!roles.length) cards.push(el('div', { class: 'role-empty', text: 'No roles match your search.' }));
    cards.push(el('button', {
      type: 'button', class: 'role-card role-new', on: { click: () => openRoleDialog() }
    }, [el('span', { class: 'icon', 'aria-hidden': 'true', text: '＋' }), el('span', { class: 'title', text: 'New role' })]));
    $('#roleGrid').replaceChildren(...cards);
  }

  const expertRoles = () => state.roleIds.map((id) => data.roles.find((r) => r.id === id)).filter(Boolean);
  const focusOptions = () => [...new Set(expertRoles().flatMap((r) => r.focusAreas))];

  /**
   * Apply a role selection change. Roles are either experts (roleIds) or reviewers (reviewerIds), never both.
   * Focus areas are trimmed to those the remaining experts offer.
   */
  function setRoles(roleIds, reviewerIds) {
    reviewerIds = reviewerIds.filter((id) => !roleIds.includes(id));
    const offered = new Set(roleIds.flatMap((id) => data.roles.find((r) => r.id === id)?.focusAreas || []));
    const focusAreas = state.focusAreas.filter((f) => offered.has(f));
    setState({ roleIds, reviewerIds, focusAreas }, { rerender: [renderRoleGrid, renderRoleDetail, renderFocusAreas, renderPatterns, renderGuardrails] });
  }

  /** Clicking a card adds it as an expert, or removes it if it's already selected in either mode. */
  function toggleRole(id) {
    if (state.roleIds.includes(id) || state.reviewerIds.includes(id)) {
      setRoles(state.roleIds.filter((x) => x !== id), state.reviewerIds.filter((x) => x !== id));
    } else {
      setRoles([...state.roleIds, id], state.reviewerIds);
    }
  }

  function setRoleMode(id, mode) {
    const roleIds = state.roleIds.filter((x) => x !== id);
    const reviewerIds = state.reviewerIds.filter((x) => x !== id);
    if (mode === 'expert') roleIds.push(id);
    else reviewerIds.push(id);
    setRoles(roleIds, reviewerIds);
  }

  function renderRoleDetail() {
    const box = $('#roleDetail');
    const selected = [
      ...state.roleIds.map((id) => ({ id, mode: 'expert' })),
      ...state.reviewerIds.map((id) => ({ id, mode: 'reviewer' }))
    ].map((s) => ({ ...s, role: data.roles.find((r) => r.id === s.id) })).filter((s) => s.role);
    box.hidden = !selected.length;
    if (!selected.length) return;

    // Roles kept from another profession are labelled so the mix is visible.
    const otherProfession = (role) => {
      if ((role.profession || PromptBuilder.DEFAULT_PROFESSION) === state.profession) return null;
      const p = (data.options.professions || []).find((x) => x.id === role.profession);
      return p ? el('span', { class: 'badge', text: `${p.icon} ${p.label}` }) : null;
    };
    const modeSwitch = ({ id, mode, role }) =>
      el('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': `Mode for ${role.title}` },
        [['expert', 'Expert', 'Shapes the answer'], ['reviewer', 'Reviewer', 'Critiques the draft, then it is revised']].map(([value, label, hint]) =>
          el('button', {
            type: 'button', role: 'radio', 'aria-checked': String(mode === value), title: hint,
            on: { click: () => mode !== value && setRoleMode(id, value) }
          }, label)
        )
      );

    box.replaceChildren(
      el('p', { class: 'role-hint', text: 'Select more cards to combine roles, even across professions. Experts shape the answer; reviewers critique the draft so it can be improved.' }),
      el('ul', { class: 'selected-roles' }, selected.map((s) =>
        el('li', {}, [
          el('div', { class: 'selected-role-info' }, [
            el('strong', { text: `${s.role.icon} ${s.role.title}` }, [otherProfession(s.role)]),
            el('span', { text: s.role.description })
          ]),
          modeSwitch(s),
          s.role.custom
            ? el('button', { type: 'button', class: 'btn btn-sm', text: 'Edit', on: { click: () => openRoleDialog(s.role) } })
            : el('button', { type: 'button', class: 'btn btn-sm', text: 'Customize', title: 'Create an editable custom role based on this one', on: { click: () => openRoleDialog(s.role, { copy: true }) } }),
          el('button', { type: 'button', class: 'del', 'aria-label': `Remove ${s.role.title}`, text: '×', on: { click: () => toggleRole(s.id) } })
        ])
      ))
    );
  }

  function renderFocusAreas() {
    const experts = expertRoles();
    $('#focusWrap').hidden = !experts.length;
    if (!experts.length) return;
    $('#focusRoleName').textContent = `for ${experts.map((r) => r.title).join(', ')}`;
    renderToggleChips($('#focusAreas'), focusOptions(), 'focusAreas');
  }

  function renderTechStack() {
    $('#techStack').replaceChildren(
      ...visible(data.options.techStack).map((g) => {
        const chips = el('div', { class: 'chips chips-compact' });
        renderToggleChips(chips, g.items, 'techStack');
        return el('div', { class: 'stack-group' }, [el('h4', { text: g.group }), chips]);
      })
    );
  }

  /* ---------------- Design patterns ---------------- */

  let showAllPatterns = false;

  /** Pattern groups for the profession; narrowed to the groups the expert roles suggest unless "Show all" is on. */
  function renderPatterns() {
    const groups = visible(data.options.patterns);
    $('#patternsWrap').hidden = !groups.length;
    if (!groups.length) return;
    const suggesting = expertRoles().filter((r) => r.patternGroups?.length);
    const suggested = new Set(suggesting.flatMap((r) => r.patternGroups));
    const filtered = !showAllPatterns && suggested.size > 0;
    // Groups with a selected pattern stay visible so selections are never hidden.
    const shown = groups.filter((g) => !filtered || suggested.has(g.id) || g.items.some((it) => state.patterns.includes(it.label)));
    $('#patternsHint').textContent = filtered ? `suggested for ${suggesting.map((r) => r.title).join(', ')}` : 'hover a chip for a short description';
    const btn = $('#patternsAllBtn');
    btn.hidden = !suggested.size || (filtered && shown.length === groups.length);
    btn.textContent = showAllPatterns ? 'Show suggested' : `Show all ${groups.length} groups`;
    $('#patterns').replaceChildren(
      ...shown.map((g) => {
        const chips = el('div', { class: 'chips chips-compact' });
        renderToggleChips(chips, g.items, 'patterns');
        return el('div', { class: 'stack-group' }, [el('h4', { text: g.group }), chips]);
      })
    );
  }

  /* ---------------- Guardrails ---------------- */

  function renderGuardrails() {
    const rules = PromptBuilder.guardrailsFor({ ...state, guardrails: true }, data);
    $('#guardrailsWrap').hidden = !rules.length;
    $('#guardrailsToggle').checked = state.guardrails;
    $('#guardrailList').hidden = !state.guardrails;
    $('#guardrailList').replaceChildren(...rules.map((r) => el('li', { text: r })));
  }

  /* ---------------- Custom roles ---------------- */

  const ROLE_LIST_FIELDS = ['expertise', 'focusAreas', 'principles'];
  const ROLE_TEXT_FIELDS = ['title', 'icon', 'category', 'profession', 'description', 'persona'];
  let editingRoleId = null; // id of the custom role being edited, null when creating
  let copySourceId = null;  // id of the role being customized into a copy

  const getCustomRoles = () => store.get(STORAGE.customRoles, []);

  /** Built-in roles first, then the user's custom roles (marked so the UI can offer editing). */
  function refreshRoles() {
    // Custom roles saved before professions existed were all software roles.
    data.roles = [...builtInRoles, ...getCustomRoles().map((r) => ({ profession: PromptBuilder.DEFAULT_PROFESSION, ...r, custom: true }))];
  }

  /** Validate and normalise a role object (from the form or an imported file). Returns null if unusable. */
  function cleanRole(r) {
    if (!r || typeof r !== 'object') return null;
    const role = { id: typeof r.id === 'string' ? r.id : '' };
    for (const f of ROLE_TEXT_FIELDS) role[f] = typeof r[f] === 'string' ? r[f].trim() : '';
    for (const f of ROLE_LIST_FIELDS) role[f] = Array.isArray(r[f]) ? r[f].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
    if (!role.title || !role.description || !role.persona) return null;
    role.icon = role.icon || '🧩';
    role.category = role.category || 'Custom';
    role.profession = role.profession || PromptBuilder.DEFAULT_PROFESSION;
    if (Array.isArray(r.patternGroups)) role.patternGroups = r.patternGroups.filter((x) => typeof x === 'string');
    return role;
  }

  const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'role';

  function uniqueRoleId(title) {
    const base = slugify(title);
    let id = base;
    for (let n = 2; data.roles.some((r) => r.id === id); n++) id = `${base}-${n}`;
    return id;
  }

  /** Role as it should appear in data/roles.json (field order matches the built-in entries). */
  const toRoleJson = (r) => ({
    id: r.id, title: r.title, profession: r.profession, category: r.category, icon: r.icon, description: r.description,
    persona: r.persona, expertise: r.expertise, focusAreas: r.focusAreas, principles: r.principles,
    ...(r.patternGroups?.length ? { patternGroups: r.patternGroups } : {})
  });

  function openRoleDialog(role = null, { copy = false } = {}) {
    const form = $('#roleForm');
    form.reset();
    editingRoleId = role && !copy ? role.id : null;
    copySourceId = role && copy ? role.id : null;
    $('#roleDialogTitle').textContent = editingRoleId ? 'Edit role' : copy ? `New role based on ${role.title}` : 'New role';
    $('#deleteRoleBtn').hidden = !editingRoleId;
    $('#roleFormError').hidden = true;
    $('#roleCategoryList').replaceChildren(...[...new Set(professionRoles().map((r) => r.category))].map((c) => el('option', { value: c })));
    $('#rfProfession').replaceChildren(...(data.options.professions || []).map((p) => el('option', { value: p.id, text: `${p.icon} ${p.label}` })));
    form.elements.profession.value = state.profession;
    if (role) {
      for (const f of ROLE_TEXT_FIELDS) form.elements[f].value = role[f] || '';
      for (const f of ROLE_LIST_FIELDS) form.elements[f].value = (role[f] || []).join('\n');
      if (copy) {
        form.elements.title.value = `${role.title} (custom)`;
        form.elements.category.value = 'Custom';
      }
    }
    $('#roleDialog').showModal();
    form.elements.title.focus();
  }

  function readRoleForm() {
    const f = $('#roleForm').elements;
    const raw = { id: editingRoleId || uniqueRoleId(f.title.value) };
    for (const k of ROLE_TEXT_FIELDS) raw[k] = f[k].value;
    for (const k of ROLE_LIST_FIELDS) raw[k] = f[k].value.split('\n');
    // Pattern suggestions aren't editable in the form; carry them over from the edited or copied role.
    raw.patternGroups = data.roles.find((r) => r.id === (editingRoleId || copySourceId))?.patternGroups;
    return cleanRole(raw);
  }

  function showRoleFormError() {
    const err = $('#roleFormError');
    err.textContent = 'Title, short description and persona are required.';
    err.hidden = false;
  }

  function saveRole(e) {
    e.preventDefault();
    const role = readRoleForm();
    if (!role) return showRoleFormError();
    const roles = getCustomRoles();
    const idx = roles.findIndex((r) => r.id === role.id);
    if (idx >= 0) roles[idx] = role;
    else roles.push(role);
    store.set(STORAGE.customRoles, roles);
    refreshRoles();
    $('#roleDialog').close();
    // Make the role immediately usable: a customized copy takes the place of its source role
    // (same position and mode); a brand-new role is added as an expert.
    const swap = (ids) => ids.map((id) => (id === copySourceId ? role.id : id));
    if (copySourceId && [...state.roleIds, ...state.reviewerIds].includes(copySourceId)) {
      setRoles(swap(state.roleIds), swap(state.reviewerIds));
    } else if (!state.roleIds.includes(role.id) && !state.reviewerIds.includes(role.id)) {
      setRoles([...state.roleIds, role.id], state.reviewerIds);
    } else {
      setRoles(state.roleIds, state.reviewerIds); // edited in place: re-render with new details
    }
    renderRoleCategories();
    toast(idx >= 0 ? 'Role updated' : 'Role created');
  }

  function deleteRole() {
    const role = data.roles.find((r) => r.id === editingRoleId);
    if (!role || !window.confirm(`Delete the role “${role.title}”? Saved templates that use it will lose their role.`)) return;
    store.set(STORAGE.customRoles, getCustomRoles().filter((r) => r.id !== role.id));
    refreshRoles();
    $('#roleDialog').close();
    setRoles(state.roleIds.filter((id) => id !== role.id), state.reviewerIds.filter((id) => id !== role.id));
    renderRoleCategories();
    toast('Role deleted');
  }

  function copyRoleJson() {
    const role = readRoleForm();
    if (!role) return showRoleFormError();
    copyText(JSON.stringify(toRoleJson(role), null, 2), 'Role JSON copied. Paste it into the "roles" list in data/roles.json');
  }

  /* ---------------- Text fields ---------------- */

  function bindTextFields() {
    document.querySelectorAll('[data-field]').forEach((input) => {
      const key = input.dataset.field;
      input.value = state[key] ?? '';
      input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => setState({ [key]: input.value }));
    });
  }

  function renderAudience() {
    const select = $('#audience');
    select.replaceChildren(...visible(data.options.audiences).map((a) => el('option', { value: a.id, text: a.label })));
    select.value = state.audience;
  }

  /* ---------------- Task guidance ---------------- */

  const DEFAULT_PLACEHOLDER = document.getElementById('description').placeholder;
  const DEFAULT_CONTEXT_PLACEHOLDER = document.getElementById('context').placeholder;
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // An item counts as covered once the description has a line starting with "<item>:".
  const hasHeading = (text, item) => new RegExp(`^\\s*${escapeRegExp(item)}\\s*:`, 'im').test(text);

  function renderTaskGuide() {
    const task = data.options.taskTypes.find((t) => t.id === state.taskType);
    const box = $('#taskGuide');
    $('#description').placeholder = task?.placeholder || currentProfession()?.descriptionPlaceholder || DEFAULT_PLACEHOLDER;
    box.hidden = !task?.checklist?.length;
    if (box.hidden) return;
    $('#guideTitle').textContent = `For “${task.label}”, include:`;
    $('#guideList').replaceChildren(
      ...task.checklist.map((item) => el('li', { class: hasHeading(state.description, item) ? 'done' : null, text: item }))
    );
  }

  function insertOutline() {
    const task = data.options.taskTypes.find((t) => t.id === state.taskType);
    const missing = (task?.checklist || []).filter((item) => !hasHeading(state.description, item));
    if (!missing.length) return toast('Outline already in place');
    const current = state.description.trimEnd();
    const next = (current ? current + '\n\n' : '') + missing.map((item) => `${item}: `).join('\n');
    const textarea = $('#description');
    textarea.value = next;
    setState({ description: next });
    textarea.focus();
    // Put the cursor after the first newly inserted heading.
    const pos = next.indexOf(`${missing[0]}: `, current.length) + missing[0].length + 2;
    textarea.setSelectionRange(pos, pos);
  }

  /* ---------------- Output ---------------- */

  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function highlight(text) {
    return escapeHtml(text)
      .split('\n')
      .map((line) => {
        if (/^#{1,3} /.test(line)) return `<span class="h">${line}</span>`;
        if (/^&lt;\/?[a-z_]+&gt;$/.test(line)) return `<span class="t">${line}</span>`;
        if (state.style === 'plain' && /^[A-Z][A-Z &amp;]+$/.test(line)) return `<span class="h">${line}</span>`;
        if (/^&gt; /.test(line) || /^"""$/.test(line)) return `<span class="q">${line}</span>`;
        return line
          .replace(/^(\s*(?:- \[ \]|-|\d+\.)) /, '<span class="l">$1</span> ')
          .replace(/\*\*(.+?)\*\*/g, '<span class="b">$1</span>');
      })
      .join('\n');
  }

  function updateOutput() {
    currentPrompt = PromptBuilder.build(state, data);
    const { score, tips } = PromptBuilder.analyze(state, data);
    const words = currentPrompt.trim() ? currentPrompt.trim().split(/\s+/).length : 0;

    $('#preview').innerHTML = highlight(currentPrompt);
    $('#empty').hidden = !!currentPrompt;
    $('#stats').textContent = `${words} words · ~${PromptBuilder.estimateTokens(currentPrompt)} tokens`;

    $('#scoreValue').textContent = score;
    const bar = $('#scoreBar');
    bar.style.strokeDasharray = `${score} 100`;
    bar.style.stroke = score >= 80 ? 'var(--success)' : score >= 50 ? 'var(--warn)' : 'var(--danger)';
    $('#score').title = `Prompt strength: ${score}/100`;

    $('#tips').replaceChildren(...tips.slice(0, 3).map((t) => el('li', { text: t })));

    const len = state.description.trim().length;
    $('#descCount').textContent = `${len} chars`;
    $('#descCount').className = len >= 40 ? 'good' : '';

    ['#copyBtn', '#downloadBtn', '#saveBtn'].forEach((s) => ($(s).disabled = !currentPrompt));
    renderTaskGuide();
    updateAiButtons();
  }

  /* ---------------- Actions ---------------- */

  function toast(msg, ms = 1800) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), ms);
  }

  async function copyText(text, message) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(message);
  }

  const copyPrompt = () => copyText(currentPrompt, 'Prompt copied to clipboard');

  function downloadPrompt() {
    if (!currentPrompt) return;
    const ext = state.style === 'markdown' ? 'md' : 'txt';
    const name = `${(state.roleIds[0] || 'prompt')}-${new Date().toISOString().slice(0, 10)}.${ext}`;
    const url = URL.createObjectURL(new Blob([currentPrompt], { type: 'text/plain' }));
    el('a', { href: url, download: name }).click();
    URL.revokeObjectURL(url);
    toast(`Downloaded ${name}`);
  }

  /* ---------------- Template library (versions, import/export) ---------------- */

  // Template shape: { id, name, versions: [{ savedAt, state }] }, oldest version first.
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const latest = (t) => t.versions[t.versions.length - 1];
  const sameState = (a, b) => JSON.stringify(sanitizeState(a)) === JSON.stringify(sanitizeState(b));
  const formatDate = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  /** Accepts the current shape and the older single-version shape { id, name, savedAt, state }. */
  function normalizeTemplate(t) {
    if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.name.trim()) return null;
    const rawVersions = Array.isArray(t.versions) ? t.versions : [{ savedAt: t.savedAt, state: t.state }];
    const versions = rawVersions
      .filter((v) => v && typeof v.state === 'object')
      .map((v) => ({ savedAt: Number(v.savedAt) || Date.now(), state: sanitizeState(v.state) }))
      .sort((a, b) => a.savedAt - b.savedAt)
      .slice(-MAX_VERSIONS);
    if (!versions.length) return null;
    return { id: typeof t.id === 'string' && t.id ? t.id : newId(), name: t.name.trim(), versions };
  }

  const getTemplates = () => store.get(STORAGE.saved, []).map(normalizeTemplate).filter(Boolean);
  const setTemplates = (list) => store.set(STORAGE.saved, list);
  let activeTemplateId = store.get(STORAGE.activeTemplate, null);
  const setActiveTemplate = (id) => { activeTemplateId = id; store.set(STORAGE.activeTemplate, id); };

  function defaultTemplateName() {
    const active = getTemplates().find((t) => t.id === activeTemplateId);
    if (active) return active.name;
    const roles = expertRoles().map((r) => r.title).join(' + ');
    const task = data.options.taskTypes.find((t) => t.id === state.taskType);
    return [roles, task?.label].filter(Boolean).join(' · ') || 'Untitled prompt';
  }

  /** Saving under an existing name adds a new version to that template. */
  function saveTemplate() {
    const name = window.prompt('Name this template (use an existing name to save a new version)', defaultTemplateName())?.trim();
    if (!name) return;
    const templates = getTemplates();
    const existing = templates.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (sameState(latest(existing).state, state)) return toast('No changes since the last version');
      existing.versions = [...existing.versions, { savedAt: Date.now(), state }].slice(-MAX_VERSIONS);
      // Move to the top of the list.
      setTemplates([existing, ...templates.filter((t) => t !== existing)]);
      setActiveTemplate(existing.id);
      toast(`Saved version ${existing.versions.length} of “${existing.name}”`);
    } else {
      const t = { id: newId(), name, versions: [{ savedAt: Date.now(), state }] };
      setTemplates([t, ...templates]);
      setActiveTemplate(t.id);
      toast('Template saved');
    }
    renderSaved();
  }

  function renderSaved() {
    const templates = getTemplates();
    $('#savedEmpty').hidden = templates.length > 0;
    $('#exportBtn').disabled = !templates.length;
    $('#savedList').replaceChildren(
      ...templates.map((t) =>
        el('li', { class: t.id === activeTemplateId ? 'active' : null }, [
          el('button', {
            type: 'button', class: 'load', title: 'Load latest version',
            on: { click: () => { loadState(latest(t).state); setActiveTemplate(t.id); renderSaved(); toast(`Loaded “${t.name}”`); } }
          }, [t.name, el('small', { text: `v${t.versions.length} · ${new Date(latest(t).savedAt).toLocaleDateString()}` })]),
          el('button', {
            type: 'button', class: 'icon-btn', title: 'Version history', 'aria-label': `Version history of ${t.name}`, text: '🕘',
            on: { click: () => openHistory(t.id) }
          }),
          el('button', {
            type: 'button', class: 'del', 'aria-label': `Delete ${t.name}`, text: '×',
            on: { click: () => {
              if (!window.confirm(`Delete “${t.name}” and all ${t.versions.length} version(s)?`)) return;
              setTemplates(getTemplates().filter((x) => x.id !== t.id));
              if (activeTemplateId === t.id) setActiveTemplate(null);
              renderSaved();
            } }
          })
        ])
      )
    );
  }

  /* ----- Version history & diff ----- */

  const DIFF_FIELDS = [
    ['profession', 'Profession', 'professions'], ['roleIds', 'Expert roles', 'roles'], ['reviewerIds', 'Reviewer roles', 'roles'], ['taskType', 'Task type', 'taskTypes'],
    ['description', 'Description'], ['context', 'Background context'], ['techStack', 'Tech stack'], ['customStack', 'Other technologies'],
    ['focusAreas', 'Focus areas'], ['patterns', 'Design patterns'], ['constraints', 'Constraints', 'constraints'],
    ['customConstraints', 'Custom requirements'], ['guardrails', 'Guardrails'],
    ['reasoning', 'Approach', 'reasoning'], ['outputFormats', 'Output format', 'outputFormats'], ['audience', 'Audience', 'audiences'],
    ['tone', 'Tone', 'tones'], ['length', 'Length', 'lengths'], ['successCriteria', 'Success criteria'], ['examples', 'Examples'],
    ['style', 'Prompt style', 'promptStyles']
  ];
  const LONG_TEXT = new Set(['description', 'context', 'customConstraints', 'successCriteria', 'examples']);

  /** Human label for an id stored in state (role title, option label…), falling back to the raw id. */
  function labelFor(source, id) {
    if (typeof id === 'boolean') return id ? 'On' : 'Off';
    if (!source || !id) return id || '—';
    const list = source === 'roles' ? data.roles : data.options[source];
    const item = (list || []).find((x) => x.id === id);
    return item ? item.title || item.label : `${id} (missing)`;
  }

  /** Line diff via longest common subsequence; inputs are small (form fields). */
  function diffLines(a, b) {
    const x = a ? a.split('\n') : [];
    const y = b ? b.split('\n') : [];
    const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { out.push(['same', x[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['del', x[i++]]);
      else out.push(['ins', y[j++]]);
    }
    while (i < x.length) out.push(['del', x[i++]]);
    while (j < y.length) out.push(['ins', y[j++]]);
    return out;
  }

  function renderFieldDiff(key, label, source, before, after) {
    let body;
    if (Array.isArray(after)) {
      const removed = before.filter((v) => !after.includes(v));
      const added = after.filter((v) => !before.includes(v));
      body = el('div', { class: 'diff-chips' }, [
        ...added.map((v) => el('span', { class: 'chip-ins', text: `+ ${labelFor(source, v)}` })),
        ...removed.map((v) => el('span', { class: 'chip-del', text: `− ${labelFor(source, v)}` }))
      ]);
    } else if (LONG_TEXT.has(key)) {
      body = el('pre', { class: 'diff-lines' }, diffLines(before, after).map(([kind, line]) =>
        el('span', { class: kind === 'same' ? null : kind, text: `${kind === 'ins' ? '+ ' : kind === 'del' ? '− ' : '  '}${line || ' '}` })
      ));
    } else {
      body = el('div', { class: 'diff-chips' }, [
        el('span', { class: 'chip-del', text: labelFor(source, before) }),
        el('span', { text: '→' }),
        el('span', { class: 'chip-ins', text: labelFor(source, after) })
      ]);
    }
    return el('section', { class: 'diff-field' }, [el('h4', { text: label }), body]);
  }

  let historyView = { templateId: null, index: 0 };

  function openHistory(templateId) {
    const t = getTemplates().find((x) => x.id === templateId);
    if (!t) return;
    historyView = { templateId, index: t.versions.length - 1 };
    $('#historyTitle').textContent = `Version history · ${t.name}`;
    renderHistory();
    $('#historyDialog').showModal();
  }

  function renderHistory() {
    const t = getTemplates().find((x) => x.id === historyView.templateId);
    if (!t) return;
    const { index } = historyView;
    $('#historyList').replaceChildren(
      ...t.versions.map((v, i) => ({ v, i })).reverse().map(({ v, i }) =>
        el('li', {}, el('button', {
          type: 'button', 'aria-current': String(i === index),
          on: { click: () => { historyView.index = i; renderHistory(); } }
        }, [`Version ${i + 1}${i === t.versions.length - 1 ? ' (latest)' : ''}`, el('small', { text: formatDate(v.savedAt) })]))
      )
    );

    const current = t.versions[index].state;
    const previous = index > 0 ? t.versions[index - 1].state : null;
    const diff = $('#historyDiff');
    if (!previous) {
      diff.replaceChildren(el('p', { class: 'diff-empty', text: 'First version. Later versions show what changed compared with the one before.' }));
    } else {
      const changed = DIFF_FIELDS.filter(([key]) => JSON.stringify(previous[key]) !== JSON.stringify(current[key]));
      diff.replaceChildren(
        ...(changed.length
          ? changed.map(([key, label, source]) => renderFieldDiff(key, label, source, previous[key], current[key]))
          : [el('p', { class: 'diff-empty', text: 'No changes compared with the previous version.' })])
      );
    }
    $('#historyMeta').textContent = previous ? `Changes from version ${index} to version ${index + 1}` : '';
  }

  function restoreVersion() {
    const t = getTemplates().find((x) => x.id === historyView.templateId);
    if (!t) return;
    loadState(t.versions[historyView.index].state);
    setActiveTemplate(t.id);
    renderSaved();
    $('#historyDialog').close();
    toast(`Loaded version ${historyView.index + 1}. Save to make it the latest.`, 3000);
  }

  /* ----- Import / export ----- */

  function exportTemplates() {
    const templates = getTemplates();
    if (!templates.length) return;
    // Bundle the custom roles the templates use so they work on another machine.
    const usedIds = new Set(templates.flatMap((t) => t.versions.flatMap((v) => [...v.state.roleIds, ...v.state.reviewerIds])));
    const roles = getCustomRoles().filter((r) => usedIds.has(r.id)).map(toRoleJson);
    const file = { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), templates, roles };
    const name = `prompt-templates-${new Date().toISOString().slice(0, 10)}.json`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    el('a', { href: url, download: name }).click();
    URL.revokeObjectURL(url);
    toast(`Exported ${templates.length} template(s)${roles.length ? ` and ${roles.length} custom role(s)` : ''}`);
  }

  async function importTemplates(e) {
    const file = e.target.files[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return toast('That file is not valid JSON.', 4000);
    }
    if (parsed?.format !== EXPORT_FORMAT || !Array.isArray(parsed.templates)) {
      return toast('Not a Prompt Builder templates file.', 4000);
    }

    // Roles: add ones we don't have; never overwrite an existing role with the same id.
    const customRoles = getCustomRoles();
    let rolesAdded = 0;
    for (const r of Array.isArray(parsed.roles) ? parsed.roles : []) {
      const role = cleanRole(r);
      if (role && role.id && !data.roles.some((x) => x.id === role.id)) {
        customRoles.push(role);
        data.roles.push({ ...role, custom: true });
        rolesAdded++;
      }
    }
    store.set(STORAGE.customRoles, customRoles);
    refreshRoles();

    // Templates: merge versions into a same-named template, otherwise add as new.
    const templates = getTemplates();
    let added = 0, merged = 0, skipped = 0;
    for (const raw of parsed.templates) {
      const incoming = normalizeTemplate(raw);
      if (!incoming) { skipped++; continue; }
      const existing = templates.find((t) => t.name.toLowerCase() === incoming.name.toLowerCase());
      if (!existing) {
        templates.push({ ...incoming, id: newId() });
        added++;
        continue;
      }
      const known = new Set(existing.versions.map((v) => `${v.savedAt}|${JSON.stringify(v.state)}`));
      const fresh = incoming.versions.filter((v) => !known.has(`${v.savedAt}|${JSON.stringify(v.state)}`));
      if (fresh.length) {
        existing.versions = [...existing.versions, ...fresh].sort((a, b) => a.savedAt - b.savedAt).slice(-MAX_VERSIONS);
        merged++;
      }
    }
    setTemplates(templates);
    renderAll();

    const parts = [`${added} new`, merged && `${merged} updated`, rolesAdded && `${rolesAdded} role(s) added`, skipped && `${skipped} invalid skipped`].filter(Boolean);
    toast(`Imported templates: ${parts.join(', ')}`, 4000);
  }

  function loadState(next) {
    state = sanitizeState(next);
    store.set(STORAGE.draft, state);
    renderAll();
  }

  function resetAll() {
    if (!window.confirm('Clear all inputs?')) return;
    setActiveTemplate(null);
    loadState({});
    toast('Cleared');
  }

  /* ---------------- AI (optional, server-side Claude API) ---------------- */

  const ai = { enabled: store.get(STORAGE.ai, false), configured: false, statusLoaded: false, model: '', busy: false };
  let testAbort = null;
  let lastRefine = null;

  async function loadAiStatus() {
    try {
      const s = await fetch('/api/ai/status').then((r) => r.json());
      Object.assign(ai, { configured: s.configured, model: s.model, statusLoaded: true });
    } catch {
      ai.configured = false;
    }
    renderAi();
  }

  function renderAi() {
    $('#aiToggle').checked = ai.enabled;
    $('#aiBody').hidden = !ai.enabled;
    const status = $('#aiStatus');
    status.className = ai.configured ? 'ai-status' : 'ai-status warn';
    status.textContent = ai.configured
      ? `Ready · ${ai.model}. Each click makes a paid API call.`
      : 'Not configured: add ANTHROPIC_API_KEY to .env and restart the server.';
    updateAiButtons();
  }

  function updateAiButtons() {
    const off = !ai.enabled || !ai.configured || !currentPrompt || ai.busy;
    $('#refineBtn').disabled = off;
    $('#testBtn').disabled = off;
  }

  function toggleAi(e) {
    ai.enabled = e.target.checked;
    store.set(STORAGE.ai, ai.enabled);
    if (ai.enabled && !ai.statusLoaded) loadAiStatus();
    else renderAi();
  }

  async function postJson(url, body, signal) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    return res;
  }

  const formatUsage = (u) => (u ? `${u.model} · ${u.input_tokens} in / ${u.output_tokens} out tokens` : '');

  async function refinePrompt() {
    if (!currentPrompt) return;
    $('#refineLoading').hidden = false;
    $('#refineResult').hidden = true;
    $('#refineUsage').textContent = '';
    ['#applyAnswersBtn', '#copyRefinedBtn', '#testRefinedBtn'].forEach((s) => ($(s).disabled = true));
    $('#refineDialog').showModal();
    ai.busy = true;
    updateAiButtons();
    try {
      lastRefine = await (await postJson('/api/ai/refine', { prompt: currentPrompt })).json();
      showRefineResult(lastRefine);
    } catch (err) {
      $('#refineDialog').close();
      toast(err.message, 5000);
    } finally {
      ai.busy = false;
      updateAiButtons();
    }
  }

  function showRefineResult(r) {
    $('#refineLoading').hidden = true;
    $('#refineResult').hidden = false;
    $('#refineQuestionsWrap').hidden = !r.questions.length;
    $('#refineQuestions').replaceChildren(
      ...r.questions.map((q, i) =>
        el('li', {}, [q, el('input', { class: 'input', 'data-question': q, 'aria-label': `Answer to question ${i + 1}`, placeholder: 'Your answer (optional)' })])
      )
    );
    $('#refineChanges').replaceChildren(...r.changes.map((c) => el('li', { text: c })));
    $('#refinePrompt').innerHTML = highlight(r.improved_prompt);
    $('#refineUsage').textContent = formatUsage(r.usage);
    $('#applyAnswersBtn').hidden = !r.questions.length;
    ['#applyAnswersBtn', '#copyRefinedBtn', '#testRefinedBtn'].forEach((s) => ($(s).disabled = false));
  }

  function applyAnswers() {
    const answered = [...document.querySelectorAll('#refineQuestions [data-question]')].filter((i) => i.value.trim());
    if (!answered.length) return toast('Answer at least one question first');
    const block = 'Additional details:\n' + answered.map((i) => `- ${i.dataset.question} ${i.value.trim()}`).join('\n');
    const context = state.context.trim() ? `${state.context.trim()}\n\n${block}` : block;
    $('#context').value = context;
    setState({ context });
    $('#refineDialog').close();
    toast('Answers added to Background context');
  }

  async function testPrompt(text) {
    if (!text) return;
    const out = $('#testOutput');
    const body = out.parentElement;
    out.textContent = '';
    $('#testLoading').hidden = false;
    $('#testUsage').textContent = '';
    $('#stopTestBtn').hidden = false;
    $('#copyAnswerBtn').disabled = true;
    if (!$('#testDialog').open) $('#testDialog').showModal();

    const append = (s) => {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      out.append(s);
      if (atBottom) body.scrollTop = body.scrollHeight;
    };
    const handle = (ev) => {
      if (ev.type === 'text') { $('#testLoading').hidden = true; append(ev.text); }
      else if (ev.type === 'reset') out.textContent = '';
      else if (ev.type === 'error') append(`\n\n⚠️ ${ev.message}`);
      else if (ev.type === 'done') {
        $('#testUsage').textContent = formatUsage(ev.usage);
        if (ev.stop_reason === 'refusal') append('\n\n⚠️ The model declined to answer this prompt.');
        if (ev.stop_reason === 'max_tokens') append('\n\n⚠️ The answer was cut off at the token limit.');
      }
    };

    testAbort = new AbortController();
    ai.busy = true;
    updateAiButtons();
    try {
      const res = await postJson('/api/ai/test', { prompt: text }, testAbort.signal);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (chunk.startsWith('data: ')) handle(JSON.parse(chunk.slice(6)));
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') append(`\n\n⚠️ ${err.message}`);
    } finally {
      testAbort = null;
      ai.busy = false;
      updateAiButtons();
      $('#testLoading').hidden = true;
      $('#stopTestBtn').hidden = true;
      $('#copyAnswerBtn').disabled = !out.textContent;
    }
  }

  function bindAi() {
    $('#aiToggle').addEventListener('change', toggleAi);
    $('#refineBtn').addEventListener('click', refinePrompt);
    $('#testBtn').addEventListener('click', () => testPrompt(currentPrompt));
    $('#applyAnswersBtn').addEventListener('click', applyAnswers);
    $('#copyRefinedBtn').addEventListener('click', () => copyText(lastRefine?.improved_prompt, 'Refined prompt copied'));
    $('#testRefinedBtn').addEventListener('click', () => {
      $('#refineDialog').close();
      testPrompt(lastRefine?.improved_prompt);
    });
    $('#stopTestBtn').addEventListener('click', () => testAbort?.abort());
    $('#copyAnswerBtn').addEventListener('click', () => copyText($('#testOutput').textContent, 'Answer copied'));
    // Closing the test dialog stops generation so no further tokens are spent.
    $('#testDialog').addEventListener('close', () => testAbort?.abort());
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
    if (ai.enabled) loadAiStatus();
    else renderAi();
  }

  /* ---------------- Theme ---------------- */

  function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
  function toggleTheme() {
    const current = document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store.set(STORAGE.theme, next);
  }

  /* ---------------- Init ---------------- */

  function renderAll() {
    const o = data.options;
    renderProfessions();
    renderRoleCategories();
    renderRoleGrid();
    renderRoleDetail();
    renderFocusAreas();
    renderPatterns();
    renderRadioChips($('#taskTypes'), visible(o.taskTypes), 'taskType');
    renderTechStack();
    renderToggleChips($('#constraints'), visible(o.constraints), 'constraints');
    renderToggleChips($('#reasoning'), visible(o.reasoning), 'reasoning');
    renderGuardrails();
    renderToggleChips($('#outputFormats'), visible(o.outputFormats), 'outputFormats');
    renderAudience();
    renderSegmented($('#lengths'), visible(o.lengths), 'length');
    renderSegmented($('#tones'), visible(o.tones), 'tone');
    renderSegmented($('#styles'), o.promptStyles, 'style');
    document.querySelectorAll('[data-field]').forEach((i) => (i.value = state[i.dataset.field] ?? ''));
    renderSaved();
    updateOutput();
  }

  async function init() {
    applyTheme(store.get(STORAGE.theme, null));
    try {
      const [roles, options] = await Promise.all([
        fetch('/api/roles').then((r) => r.json()),
        fetch('/api/options').then((r) => r.json())
      ]);
      builtInRoles = roles.roles;
      data = { roles: [], options };
      refreshRoles();
    } catch (err) {
      toast('Failed to load roles/options. Is the server running?');
      console.error(err);
      return;
    }

    // Drop stale role ids (e.g. after the role JSON changed or a custom role was deleted).
    const roleExists = (id) => data.roles.some((r) => r.id === id);
    state.roleIds = state.roleIds.filter(roleExists);
    state.reviewerIds = state.reviewerIds.filter(roleExists);
    if (!(data.options.professions || []).some((p) => p.id === state.profession)) state.profession = PromptBuilder.DEFAULT_PROFESSION;

    bindTextFields();
    renderAll();

    $('#roleSearch').addEventListener('input', (e) => { roleFilter.query = e.target.value; renderRoleGrid(); });
    $('#copyBtn').addEventListener('click', copyPrompt);
    $('#downloadBtn').addEventListener('click', downloadPrompt);
    $('#saveBtn').addEventListener('click', saveTemplate);
    $('#resetBtn').addEventListener('click', resetAll);
    $('#themeBtn').addEventListener('click', toggleTheme);
    $('#insertOutline').addEventListener('click', insertOutline);
    $('#patternsAllBtn').addEventListener('click', () => { showAllPatterns = !showAllPatterns; renderPatterns(); });
    $('#guardrailsToggle').addEventListener('change', (e) => setState({ guardrails: e.target.checked }, { rerender: [renderGuardrails] }));
    $('#roleForm').addEventListener('submit', saveRole);
    $('#deleteRoleBtn').addEventListener('click', deleteRole);
    $('#copyRoleJsonBtn').addEventListener('click', copyRoleJson);
    $('#restoreVersionBtn').addEventListener('click', restoreVersion);
    $('#exportBtn').addEventListener('click', exportTemplates);
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', importTemplates);
    bindAi();
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); copyPrompt(); }
    });
  }

  init();
})();
