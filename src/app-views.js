/* Views: Jenkins-like tab bar, job table preview, orphans and the settings form. */
(function () {
  'use strict';
  const C = window.JcascCore;
  const App = window.App;
  const { S, h, $ } = App;

  const DEFAULT_COLUMNS = ['status', 'weather', 'jobName', 'lastSuccess', 'lastFailure', 'lastDuration', 'buildButton'];
  const LIST_KEYS = ['name', 'description', 'jobNames', 'includeRegex', 'columns', 'recurse'];
  const SIMPLE_KEYS = ['name', 'description'];
  const na = () => h('span', { class: 'na' }, 'N/A');
  const COLS = {
    status: ['S', (r) => h('span', { class: 'ball' + (r.missing ? ' miss' : '') })],
    weather: ['W', (r) => (r.missing ? '' : h('span', { class: 'weather' }, '☀'))],
    jobName: ['Name ↓', null],
    lastSuccess: ['Last Success', na],
    lastFailure: ['Last Failure', na],
    lastStable: ['Last Stable', na],
    lastDuration: ['Last Duration', na],
    buildButton: ['', (r) => (r.missing ? '' : h('span', { class: 'buildbtn', title: 'Build' }, '▶'))],
    jobDescription: ['Description', () => ''],
    favoriteColumn: ['★', () => '☆'],
    lastBuildConsoleColumn: ['Console', () => '▤'],
  };
  const colName = (c) => (typeof c === 'string' ? c : c && typeof c === 'object' ? Object.keys(c)[0] : String(c));

  const cur = (m) => (m || S.model).views[S.selView];

  function viewLevel(i) {
    let lvl = '';
    for (const it of S.issues) {
      if (!it.target || it.target.view !== i) continue;
      if (it.level === 'error') return 'err';
      if (it.level === 'warn') lvl = 'warn';
    }
    return lvl;
  }

  App.selectView = function (i) {
    S.selView = i;
    S.jobQuery = '';
    App.render(true);
  };

  // ---------- mutations ----------
  function setJobMembership(view, name, on) {
    const cfg = view.cfg;
    const names = Array.isArray(cfg.jobNames) ? cfg.jobNames.slice() : [];
    const lower = name.toLowerCase();
    const has = names.some((n) => String(n).toLowerCase() === lower);
    if (on && !has) names.push(name);
    if (!on) {
      const left = names.filter((n) => String(n).toLowerCase() !== lower);
      if (left.length) cfg.jobNames = left; else delete cfg.jobNames;
      return;
    }
    cfg.jobNames = names;
  }

  App.addJobToView = function (vi, name) {
    const v = S.model.views[vi];
    if (!v || v.type !== 'list') return;
    App.change((m) => setJobMembership(m.views[vi], name, true));
  };

  function moveView(from, to) {
    if (from === to || from + 1 === to) return;
    App.change((m) => {
      const [v] = m.views.splice(from, 1);
      const at = to > from ? to - 1 : to;
      m.views.splice(at, 0, v);
      S.selView = at;
    });
  }

  function addView() {
    const names = new Set(S.model.views.map((v) => String(v.cfg.name || '').toLowerCase()));
    let n = 1;
    while (names.has(('New view ' + n).toLowerCase())) n++;
    App.change((m) => {
      const v = { type: 'list', cfg: { name: 'New view ' + n, columns: DEFAULT_COLUMNS.slice(), jobNames: [] }, space: false };
      const allIdx = m.views.findIndex((x) => x.type === 'all');
      const at = allIdx === -1 ? m.views.length : allIdx;
      m.views.splice(at, 0, v);
      S.selView = at;
    });
    setTimeout(() => { const el = $('#vfName'); if (el) { el.focus(); el.select(); } }, 0);
  }

  function duplicateView() {
    App.change((m) => {
      const v = C.clone(cur(m));
      v.cfg.name = (v.cfg.name || 'view') + ' copy';
      v.space = false;
      m.views.splice(S.selView + 1, 0, v);
      S.selView += 1;
    });
  }

  function deleteView() {
    const v = cur();
    if (!confirm(`Delete view "${v.cfg.name || ''}"?`)) return;
    App.change((m) => {
      m.views.splice(S.selView, 1);
      S.selView = Math.max(0, Math.min(S.selView, m.views.length - 1));
    });
  }

  function changeType(type) {
    App.change((m) => {
      const v = cur(m);
      if (v.type === type) return;
      const keep = {};
      const stash = Object.assign({}, v.stash || {});
      for (const [k, val] of Object.entries(v.cfg)) {
        if (type === 'list' || SIMPLE_KEYS.includes(k)) keep[k] = val; else stash[k] = val;
      }
      if (type === 'list') {
        Object.assign(keep, stash);
        if (!keep.columns) keep.columns = DEFAULT_COLUMNS.slice();
        delete v.stash;
      } else v.stash = stash;
      v.type = type;
      v.cfg = keep;
    });
  }

  // ---------- tab bar ----------
  function renderTabs() {
    const box = $('#viewTabs');
    box.textContent = '';
    S.model.views.forEach((v, i) => {
      const ev = S.evals[i];
      const count = ev ? ev.rows.length : 0;
      const tab = h('div', {
        class: `jtab ${i === S.selView ? 'active' : ''} ${viewLevel(i)}`,
        draggable: true,
        title: `${v.type} view${v.type === 'list' ? ` · ${count} job(s)` : ''}\nDrag to reorder · drop jobs here to add them`,
        onclick: () => App.selectView(i),
      }, v.cfg.name || '(unnamed)', h('span', { class: 'tcount' }, v.type === 'list' ? count : ''));
      tab.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/x-view', String(i));
        e.dataTransfer.effectAllowed = 'move';
      });
      tab.addEventListener('dragover', (e) => {
        const types = Array.from(e.dataTransfer.types);
        if (types.includes('text/x-view')) {
          e.preventDefault();
          const r = tab.getBoundingClientRect();
          const right = e.clientX > r.left + r.width / 2;
          tab.classList.toggle('drag-over-right', right);
          tab.classList.toggle('drag-over-left', !right);
        } else if (types.includes('text/x-job') && v.type === 'list') {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          tab.classList.add('drop-target');
        }
      });
      tab.addEventListener('dragleave', () => tab.classList.remove('drop-target', 'drag-over-left', 'drag-over-right'));
      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        const right = tab.classList.contains('drag-over-right');
        tab.classList.remove('drop-target', 'drag-over-left', 'drag-over-right');
        const from = e.dataTransfer.getData('text/x-view');
        const job = e.dataTransfer.getData('text/x-job');
        if (from !== '') moveView(Number(from), right ? i + 1 : i);
        else if (job) App.addJobToView(i, job);
      });
      box.appendChild(tab);
    });
    box.appendChild(h('div', { class: 'jtab add', title: 'Add a list view', onclick: addView }, '+'));
  }

  // ---------- preview ----------
  function renderPreview() {
    const box = $('#viewPreview');
    box.textContent = '';
    const v = cur();
    if (!v) {
      box.append(h('div', { class: 'jempty' }, 'No views defined. Click "+" to add one.'));
      return;
    }
    const ev = S.evals[S.selView];
    box.append(h('div', { class: 'jhead' },
      h('strong', {}, v.cfg.name || '(unnamed)'),
      h('span', { class: 'badge' }, v.type),
      v.cfg.description ? h('span', { class: 'vdesc' }, v.cfg.description) : null,
      h('label', { class: 'tabbar' }, 'viewsTabBar',
        h('select', {
          onchange: (e) => App.change((m) => { m.viewsTabBar = e.target.value || undefined; }),
        },
        ['standard', 'dropdown'].concat(S.model.viewsTabBar && !['standard', 'dropdown'].includes(S.model.viewsTabBar) ? [S.model.viewsTabBar] : [])
          .map((o) => h('option', { value: o, selected: (S.model.viewsTabBar || 'standard') === o }, o)))),
    ));

    if (v.type === '__raw' || ev.unsupported) {
      box.append(h('div', { class: 'jempty' }, `Preview is not available for "${v.type}" views. The block is preserved as-is.`));
      return;
    }

    const cols = Array.isArray(v.cfg.columns) && v.cfg.columns.length ? v.cfg.columns.map(colName) : DEFAULT_COLUMNS;
    const rows = ev.rows.map((r) => Object.assign({}, r))
      .concat(ev.missing.map((name) => ({ name, missing: true, byName: true })))
      .sort((a, b) => App.ci(a.name, b.name));

    if (!rows.length) {
      box.append(h('div', { class: 'jempty' },
        v.type === 'list'
          ? 'This view is empty. Tick jobs in the panel on the right, set includeRegex, or drag jobs onto the tab.'
          : 'No jobs known yet — pick the jobs folder.'));
    } else {
      const isList = v.type === 'list';
      const table = h('table', { class: 'jobs' },
        h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, COLS[c] ? COLS[c][0] : c)), isList ? h('th', {}) : null)),
        h('tbody', {}, rows.map((r) => {
          const info = App.jobInfo(r.name);
          const tr = h('tr', {
            class: r.missing ? 'missing' : '',
            draggable: !r.missing,
            title: r.missing
              ? (S.jobsLoaded ? 'Listed in jobNames but no such job in the jobs folder' : '')
              : info ? `${info.path}:${info.line}` : '',
          }, cols.map((c) => {
            if (c === 'jobName') {
              return h('td', { class: 'jn' }, r.name,
                r.byRegex ? h('span', { class: 'badge regex', title: 'Matched by includeRegex' }, 'regex') : null,
                r.byName && r.byRegex ? h('span', { class: 'badge name', title: 'Also listed in jobNames' }, 'name') : null,
                r.missing && S.jobsLoaded ? h('span', { class: 'badge missing' }, 'not found') : null);
            }
            const fn = COLS[c] && COLS[c][1];
            return h('td', {}, fn ? fn(r) : h('span', { class: 'na' }, '—'));
          }),
          isList ? h('td', { class: 'act' },
            r.byName
              ? h('button', {
                class: 'icon', title: 'Remove from jobNames',
                onclick: () => App.change((m) => setJobMembership(cur(m), r.name, false)),
              }, '✕')
              : null) : null);
          if (!r.missing) {
            tr.addEventListener('dragstart', (e) => {
              e.dataTransfer.setData('text/x-job', r.name);
              e.dataTransfer.effectAllowed = 'copy';
            });
          }
          return tr;
        })));
      box.append(table);
    }

    const byName = ev.rows.filter((r) => r.byName).length;
    const byRegex = ev.rows.filter((r) => r.byRegex).length;
    box.append(h('div', { class: 'jfoot' },
      h('span', {}, `${ev.rows.length} job(s) shown`),
      v.type === 'list' ? h('span', {}, `${byName} via jobNames`) : null,
      v.type === 'list' && v.cfg.includeRegex ? h('span', {}, `${byRegex} via includeRegex`) : null,
      ev.missing.length && S.jobsLoaded ? h('span', { style: { color: 'var(--err)' } }, `${ev.missing.length} not found`) : null,
      !S.jobsLoaded ? h('span', {}, 'Pick the jobs folder to evaluate includeRegex against real jobs.') : null,
    ));
    ev.notes.forEach((n) => box.append(h('div', { class: 'jnote' }, n)));
  }

  function renderOrphans() {
    const box = $('#orphans');
    box.textContent = '';
    if (!S.jobsLoaded) { box.hidden = true; return; }
    const covered = new Set();
    S.model.views.forEach((v, i) => { if (v.type === 'list') S.evals[i].rows.forEach((r) => covered.add(r.name)); });
    const orphans = App.universe().filter((n) => !covered.has(n));
    box.hidden = false;
    const v = cur();
    const canAdd = v && v.type === 'list';
    box.append(h('h4', { onclick: () => { S.orphansOpen = !S.orphansOpen; renderOrphans(); } },
      S.orphansOpen ? '▾' : '▸',
      `Jobs not in any list view (${orphans.length})`,
      h('span', { class: 'muted', style: { fontWeight: 400 } }, canAdd ? 'drag onto a tab or click + to add to the current view' : '')));
    if (!S.orphansOpen) return;
    box.append(h('div', { class: 'list' }, orphans.map((name) => {
      const info = App.jobInfo(name);
      const chip = h('span', { class: 'chipjob', draggable: true, title: info ? `${info.path}:${info.line}` : '' },
        name,
        canAdd ? h('button', { class: 'icon', title: `Add to "${v.cfg.name}"`, onclick: () => App.addJobToView(S.selView, name) }, '+') : null);
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/x-job', name);
        e.dataTransfer.effectAllowed = 'copy';
      });
      return chip;
    }), orphans.length ? null : h('span', { class: 'muted' }, 'Every job is shown in at least one list view.')));
  }

  // ---------- form ----------
  function regexHint() {
    const v = cur();
    const el = $('#vfRegexHint');
    const inp = $('#vfRegex');
    if (!el || !v || v.type !== 'list') return;
    const { error } = C.compileJavaRegex(v.cfg.includeRegex);
    const ev = S.evals[S.selView];
    el.className = 'hint' + (error ? ' err' : '');
    if (inp) inp.classList.toggle('bad', !!error);
    if (error) el.textContent = error;
    else if (!v.cfg.includeRegex) el.textContent = 'Java regex, must match the whole job name. Empty = not used.';
    else el.textContent = `Matches ${ev.rows.filter((r) => r.byRegex).length} job(s)`;
  }

  function renderJobChecklist() {
    const box = $('#vfJobs');
    const v = cur();
    if (!box || !v || v.type !== 'list') return;
    const scroll = box.scrollTop;
    box.textContent = '';
    const ev = S.evals[S.selView];
    const regexSet = new Set(ev.rows.filter((r) => r.byRegex).map((r) => r.name));
    const names = Array.isArray(v.cfg.jobNames) ? v.cfg.jobNames.map(String) : [];
    const inNames = new Set(names.map((n) => n.toLowerCase()));
    const U = App.universe();
    const all = U.concat(ev.missing).sort(App.ci);
    const q = S.jobQuery.toLowerCase();
    const shown = all.filter((n) => !q || n.toLowerCase().includes(q));
    shown.forEach((name) => {
      const missing = ev.missing.includes(name);
      box.append(h('label', { class: missing ? 'missing' : '', title: missing && S.jobsLoaded ? 'Not found in the jobs folder' : '' },
        h('input', {
          type: 'checkbox',
          checked: inNames.has(name.toLowerCase()),
          onchange: (e) => App.change((m) => setJobMembership(cur(m), name, e.target.checked), { full: false }),
        }),
        h('span', { class: 'n' }, name),
        regexSet.has(name) ? h('span', { class: 'badge regex' }, 'regex') : null,
        missing && S.jobsLoaded ? h('span', { class: 'badge missing' }, 'missing') : null));
    });
    if (!shown.length) box.append(h('div', { class: 'muted', style: { padding: '6px 8px' } }, all.length ? 'No matches' : 'No jobs known — pick the jobs folder or add names below.'));
    box.scrollTop = scroll;
    const cnt = $('#vfJobsCount');
    if (cnt) cnt.textContent = `${names.length} in jobNames`;
  }

  function columnsEditor(v) {
    const explicit = Array.isArray(v.cfg.columns);
    const cols = explicit ? v.cfg.columns : DEFAULT_COLUMNS;
    const setCols = (fn) => App.change((m) => {
      const c = cur(m);
      const arr = Array.isArray(c.cfg.columns) ? c.cfg.columns.slice() : DEFAULT_COLUMNS.slice();
      c.cfg.columns = fn(arr);
    });
    const present = new Set(cols.map(colName));
    const addable = C.KNOWN_COLUMNS.filter((c) => !present.has(c));
    return h('div', { class: 'row' },
      h('label', {}, 'Columns', explicit ? null : h('span', { class: 'badge' }, 'Jenkins defaults')),
      h('div', { class: 'collist' }, cols.map((c, i) => h('div', { class: 'col' },
        h('span', {}, typeof c === 'string' ? c : JSON.stringify(c)),
        h('button', { class: 'icon', title: 'Move up', disabled: i === 0, onclick: () => setCols((a) => { a.splice(i - 1, 0, a.splice(i, 1)[0]); return a; }) }, '↑'),
        h('button', { class: 'icon', title: 'Move down', disabled: i === cols.length - 1, onclick: () => setCols((a) => { a.splice(i + 1, 0, a.splice(i, 1)[0]); return a; }) }, '↓'),
        h('button', { class: 'icon', title: 'Remove', onclick: () => setCols((a) => { a.splice(i, 1); return a; }) }, '✕')))),
      h('div', { class: 'inline' },
        h('select', {
          onchange: (e) => {
            let val = e.target.value;
            if (val === '__custom') val = prompt('Column symbol (e.g. lastStable):') || '';
            if (val) setCols((a) => a.concat(val));
          },
        }, h('option', { value: '' }, '+ Add column…'), addable.map((c) => h('option', { value: c }, c)), h('option', { value: '__custom' }, 'Custom…')),
        explicit ? h('button', { class: 'small', title: 'Remove "columns" and use Jenkins defaults', onclick: () => App.change((m) => { delete cur(m).cfg.columns; }) }, 'Use defaults') : null));
  }

  function advancedEditor(v, known) {
    const extra = {};
    for (const [k, val] of Object.entries(v.cfg)) if (!known.includes(k)) extra[k] = val;
    const text = Object.keys(extra).length ? window.YAML.stringify(extra, { indent: 2, indentSeq: true }) : '';
    const hint = h('div', { class: 'hint' }, 'Any other properties of this view (e.g. jobFilters, statusFilter), as YAML.');
    const ta = h('textarea', {
      rows: Math.min(14, Math.max(3, text.split('\n').length + 1)),
      spellcheck: false,
      oninput: (e) => {
        let parsed;
        try {
          parsed = e.target.value.trim() ? window.YAML.parse(e.target.value) : {};
          if (parsed === null) parsed = {};
          if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Must be a mapping');
        } catch (err) {
          e.target.classList.add('bad');
          hint.className = 'hint err';
          hint.textContent = err.message.split('\n')[0];
          return;
        }
        e.target.classList.remove('bad');
        hint.className = 'hint';
        hint.textContent = 'OK';
        App.change((m) => {
          const c = cur(m);
          const next = {};
          for (const [k, val] of Object.entries(c.cfg)) {
            if (known.includes(k)) next[k] = val;
            else if (k in parsed) next[k] = parsed[k];
          }
          for (const [k, val] of Object.entries(parsed)) if (!(k in next) && !known.includes(k)) next[k] = val;
          c.cfg = next;
        }, { key: 'adv' + S.selView, full: false });
      },
    });
    ta.value = text;
    return h('div', { class: 'row' }, h('label', {}, 'Other properties (YAML)'), ta, hint);
  }

  function renderViewForm() {
    const box = $('#viewForm');
    const scroll = box.scrollTop;
    box.textContent = '';
    const v = cur();
    if (!v) {
      box.append(h('div', { class: 'empty' }, 'No view selected.', h('br'), h('button', { onclick: addView }, '+ Add view')));
      return;
    }
    const i = S.selView;
    const live = (key, fn) => (e) => App.change((m) => fn(cur(m), e.target), { key: key + i, full: false });

    box.append(
      h('h3', {}, 'View settings'),
      h('div', { class: 'actions' },
        h('button', { class: 'small', disabled: i === 0, title: 'Move tab left', onclick: () => moveView(i, i - 1) }, '← Move'),
        h('button', { class: 'small', disabled: i === S.model.views.length - 1, title: 'Move tab right', onclick: () => moveView(i, i + 2) }, 'Move →'),
        h('button', { class: 'small', onclick: duplicateView }, 'Duplicate'),
        h('button', { class: 'small danger', onclick: deleteView }, 'Delete')),
    );

    if (v.type === '__raw') {
      box.append(h('p', { class: 'muted' }, 'This entry does not have the "- <type>: {…}" shape and is kept unchanged.'));
      return;
    }

    const nameInput = h('input', { type: 'text', id: 'vfName', value: v.cfg.name || '', oninput: live('vname', (c, t) => { c.cfg.name = t.value; }) });
    box.append(
      h('div', { class: 'row' }, h('label', {}, 'Name'), nameInput),
      h('div', { class: 'row' }, h('label', {}, 'Type'),
        h('select', { onchange: (e) => changeType(e.target.value) },
          Array.from(new Set(C.VIEW_TYPES.concat(v.type))).map((t) => h('option', { value: t, selected: t === v.type }, t)))),
      h('div', { class: 'row' }, h('label', {}, 'Description'),
        h('textarea', {
          rows: 2,
          value: v.cfg.description || '',
          oninput: live('vdesc', (c, t) => { if (t.value) c.cfg.description = t.value; else delete c.cfg.description; }),
        })),
    );

    if (v.type === 'list') {
      box.append(
        h('div', { class: 'row' }, h('label', {}, 'includeRegex'),
          h('input', {
            type: 'text', id: 'vfRegex', value: v.cfg.includeRegex || '', placeholder: 'e.g. Q - .*', spellcheck: false,
            oninput: live('vregex', (c, t) => { if (t.value) c.cfg.includeRegex = t.value; else delete c.cfg.includeRegex; }),
          }),
          h('div', { class: 'hint', id: 'vfRegexHint' })),
        h('div', { class: 'row' },
          h('label', {}, 'Jobs (jobNames)', h('span', { class: 'badge', id: 'vfJobsCount' }),
            h('span', { class: 'spacer' }),
            h('button', {
              class: 'small', title: 'Sort jobNames alphabetically (as Jenkins does)',
              onclick: () => App.change((m) => { const c = cur(m); if (Array.isArray(c.cfg.jobNames)) c.cfg.jobNames.sort(App.ci); }),
            }, 'Sort')),
          h('input', {
            type: 'search', placeholder: 'Filter jobs…', value: S.jobQuery,
            oninput: (e) => { S.jobQuery = e.target.value; renderJobChecklist(); },
          }),
          h('div', { class: 'joblist', id: 'vfJobs' }),
          h('div', { class: 'inline' },
            h('input', {
              type: 'text', placeholder: 'Add job name manually + Enter', id: 'vfAddJob',
              onkeydown: (e) => {
                if (e.key !== 'Enter' || !e.target.value.trim()) return;
                const name = e.target.value.trim();
                e.target.value = '';
                App.change((m) => setJobMembership(cur(m), name, true), { full: false });
              },
            }))),
        columnsEditor(v),
        h('div', { class: 'row' },
          h('label', {},
            h('input', {
              type: 'checkbox', checked: !!v.cfg.recurse,
              onchange: (e) => App.change((m) => { if (e.target.checked) cur(m).cfg.recurse = true; else delete cur(m).cfg.recurse; }),
            }),
            'recurse into folders')),
        advancedEditor(v, LIST_KEYS),
      );
    } else {
      box.append(advancedEditor(v, SIMPLE_KEYS));
    }
    renderJobChecklist();
    regexHint();
    box.scrollTop = scroll;
  }

  App.renderViews = function (full) {
    renderTabs();
    renderPreview();
    renderOrphans();
    if (full) renderViewForm();
    else { renderJobChecklist(); regexHint(); }
  };
})();
