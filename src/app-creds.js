/* Credentials: table, editor form and usage lookup. */
(function () {
  'use strict';
  const C = window.JcascCore;
  const App = window.App;
  const { S, h, $ } = App;

  const BASE_KEYS = ['scope', 'id', 'description'];
  const SCOPES = ['GLOBAL', 'SYSTEM'];

  const cred = (m, sel) => {
    const s = sel || S.selCred;
    if (!s) return null;
    const d = (m || S.model).domains[s[0]];
    return d ? d.credentials[s[1]] || null : null;
  };

  function varsOf(cfg) {
    const out = [];
    for (const f of C.credentialFields(cfg, '', [])) {
      if (typeof f.value !== 'string') continue;
      const re = /\$\{([^}]*)\}/g;
      let m;
      while ((m = re.exec(f.value))) out.push(m[1]);
    }
    return out;
  }

  function usageOf(id) {
    if (!id) return [];
    return App.allRefs().filter((r) => r.id === id);
  }

  function credLevel(di, ci) {
    let lvl = '';
    for (const it of S.issues) {
      const t = it.target && it.target.cred;
      if (!t || t[0] !== di || t[1] !== ci) continue;
      if (it.level === 'error') return 'error';
      if (it.level === 'warn') lvl = 'warn';
      else if (!lvl) lvl = 'info';
    }
    return lvl;
  }

  App.selectCred = function (di, ci) {
    S.selCred = [di, ci];
    App.render(true);
  };

  // ---------- mutations ----------
  function addCredential(type) {
    App.change((m) => {
      if (!m.domains.length) m.domains.push({ extra: {}, credentials: [] });
      const di = S.selCred ? S.selCred[0] : 0;
      const list = m.domains[di].credentials;
      const at = S.selCred ? S.selCred[1] + 1 : list.length;
      list.splice(at, 0, { type, cfg: C.clone(C.CREDENTIAL_TEMPLATES[type] || { scope: 'GLOBAL', id: '', description: '' }), space: false });
      S.selCred = [di, at];
    });
    setTimeout(() => { const el = $('#cfId'); if (el) el.focus(); }, 0);
  }

  function moveCred(delta) {
    const [di, ci] = S.selCred;
    const to = ci + delta;
    if (to < 0 || to >= S.model.domains[di].credentials.length) return;
    App.change((m) => {
      const list = m.domains[di].credentials;
      list.splice(to, 0, list.splice(ci, 1)[0]);
      S.selCred = [di, to];
    });
  }

  function duplicateCred() {
    const [di, ci] = S.selCred;
    App.change((m) => {
      const c = C.clone(m.domains[di].credentials[ci]);
      c.cfg.id = (c.cfg.id || '') + '-copy';
      c.space = false;
      m.domains[di].credentials.splice(ci + 1, 0, c);
      S.selCred = [di, ci + 1];
    });
  }

  function deleteCred() {
    const c = cred();
    if (!confirm(`Delete credential "${c.cfg.id || c.type}"?`)) return;
    const [di, ci] = S.selCred;
    App.change((m) => {
      m.domains[di].credentials.splice(ci, 1);
      const len = m.domains[di].credentials.length;
      S.selCred = len ? [di, Math.min(ci, len - 1)] : App.firstCred();
    });
  }

  function changeType(type) {
    App.change((m) => {
      const c = cred(m);
      if (c.type === type) return;
      const tpl = C.CREDENTIAL_TEMPLATES[type] || {};
      const next = {};
      for (const k of BASE_KEYS) if (k in c.cfg) next[k] = c.cfg[k];
      for (const [k, v] of Object.entries(tpl)) if (!(k in next)) next[k] = k in c.cfg ? c.cfg[k] : C.clone(v);
      c.type = type;
      c.cfg = next;
    });
  }

  function setPath(obj, path, value) {
    const keys = path.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
  }

  function deletePath(obj, path) {
    const keys = path.split('.');
    const stack = [obj];
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) { cur = cur[keys[i]]; if (!cur) return; stack.push(cur); }
    delete cur[keys[keys.length - 1]];
    // Drop now-empty parent objects.
    for (let i = keys.length - 2; i >= 0; i--) {
      if (Object.keys(stack[i + 1]).length) break;
      delete stack[i][keys[i]];
    }
  }

  // ---------- table ----------
  function renderTable() {
    const box = $('#credTable');
    const scroll = box.scrollTop;
    box.textContent = '';
    const q = S.credQuery.toLowerCase();
    const multi = S.model.domains.length > 1 || S.model.domains.some((d) => Object.keys(d.extra || {}).length);
    const rows = [];
    S.model.domains.forEach((d, di) => {
      if (multi) {
        const dn = d.extra && d.extra.domain && d.extra.domain.name;
        rows.push(h('tr', { class: 'domain' }, h('td', { colspan: 7 }, dn ? `Domain: ${dn}` : 'Global domain')));
      }
      d.credentials.forEach((c, ci) => {
        const vars = varsOf(c.cfg);
        const hay = [c.type, c.cfg.id, c.cfg.description, c.cfg.scope].concat(vars).join(' ').toLowerCase();
        if (q && !hay.includes(q)) return;
        const uses = usageOf(c.cfg.id);
        const sel = S.selCred && S.selCred[0] === di && S.selCred[1] === ci;
        const lvl = credLevel(di, ci);
        rows.push(h('tr', { class: 'cred' + (sel ? ' sel' : ''), onclick: () => App.selectCred(di, ci) },
          h('td', {}, lvl ? h('span', { class: 'lv ' + lvl }) : null),
          h('td', {}, h('span', { class: 'typetag' }, c.type)),
          h('td', { class: 'id' }, c.cfg.id || h('span', { class: 'muted' }, '(no id)')),
          h('td', {}, c.cfg.description || ''),
          h('td', {}, c.cfg.scope || ''),
          h('td', { class: 'vars' }, vars.map((v) => h('code', {}, v))),
          h('td', { title: uses.map((u) => `${u.path}:${u.line}`).join('\n') },
            S.jobsLoaded || uses.length ? (uses.length ? h('span', { class: 'badge ok' }, uses.length) : h('span', { class: 'badge' }, '0')) : '—')));
      });
    });
    box.append(h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Type'), h('th', {}, 'ID'), h('th', {}, 'Description'), h('th', {}, 'Scope'), h('th', {}, 'Variables'), h('th', { title: 'References in jobs and JCasC' }, 'Used'))),
      h('tbody', {}, rows)));
    if (!rows.length) box.append(h('div', { class: 'jempty' }, S.model.domains.length ? 'No credentials match the filter.' : 'No credentials block. Add a credential to create it.'));
    box.scrollTop = scroll;
  }

  // ---------- form ----------
  function renderUsage() {
    const box = $('#cfUsage');
    const c = cred();
    if (!box || !c) return;
    box.textContent = '';
    const uses = usageOf(c.cfg.id);
    if (!uses.length) {
      box.append(h('div', { class: 'muted' }, S.jobsLoaded ? 'Not referenced by any job or JCasC setting.' : 'Pick the jobs folder to see which jobs use it.'));
      return;
    }
    for (const u of uses) {
      const dir = u.path.split('/').slice(0, -1).join('/');
      const jobs = S.jobs.filter((j) => j.path.split('/').slice(0, -1).join('/') === dir).map((j) => j.name);
      box.append(h('div', {},
        jobs.length ? h('b', {}, jobs.join(', ')) : null, jobs.length ? ' ' : null,
        h('code', {}, `${u.path}:${u.line}`), ' ', h('span', { class: 'muted' }, u.kind)));
    }
  }

  function fieldEditor(cfg, prefix, depth) {
    const out = [];
    for (const [k, v] of Object.entries(cfg)) {
      if (!prefix && BASE_KEYS.includes(k)) continue;
      const path = prefix ? prefix + '.' + k : k;
      const remove = h('button', {
        class: 'icon', title: `Remove ${path}`,
        onclick: () => App.change((m) => deletePath(cred(m).cfg, path)),
      }, '✕');
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(h('fieldset', {}, h('legend', {}, k, ' ', remove), fieldEditor(v, path, depth + 1)));
        continue;
      }
      const secret = C.SECRET_KEY_RE.test(k);
      let input;
      if (typeof v === 'boolean') {
        input = h('input', {
          type: 'checkbox', checked: v,
          onchange: (e) => App.change((m) => setPath(cred(m).cfg, path, e.target.checked)),
        });
      } else if (Array.isArray(v)) {
        input = h('textarea', {
          rows: 3, spellcheck: false, value: window.YAML.stringify(v),
          oninput: (e) => {
            try {
              const val = window.YAML.parse(e.target.value);
              e.target.classList.remove('bad');
              App.change((m) => setPath(cred(m).cfg, path, val), { key: 'cf' + path, full: false });
            } catch (err) { e.target.classList.add('bad'); }
          },
        });
      } else {
        const isNum = typeof v === 'number';
        const str = v == null ? '' : String(v);
        const plain = secret && str && !/\$\{[^}]+\}/.test(str);
        input = h('input', {
          type: 'text', value: str, spellcheck: false,
          class: plain ? 'bad' : '',
          title: plain ? 'Plain-text secret — prefer ${ENV_VAR}' : '',
          oninput: (e) => {
            const t = e.target.value;
            e.target.classList.toggle('bad', secret && !!t && !/\$\{[^}]+\}/.test(t));
            const val = isNum && t.trim() !== '' && !isNaN(Number(t)) ? Number(t) : t;
            App.change((m) => setPath(cred(m).cfg, path, val), { key: 'cf' + path, full: false });
          },
        });
      }
      out.push(h('div', { class: 'row' },
        h('label', {}, k, secret ? h('span', { class: 'badge secret' }, 'secret') : null, h('span', { class: 'spacer' }), remove),
        input));
    }
    return out;
  }

  function domainEditor(d, di) {
    const text = Object.keys(d.extra || {}).length ? window.YAML.stringify(d.extra) : '';
    const hint = h('div', { class: 'hint' }, 'Domain definition of this group (e.g. domain: {name, description, specifications}). Empty = global domain.');
    const ta = h('textarea', {
      rows: Math.max(3, text.split('\n').length + 1), spellcheck: false, value: text,
      oninput: (e) => {
        try {
          let val = e.target.value.trim() ? window.YAML.parse(e.target.value) : {};
          if (val === null) val = {};
          if (typeof val !== 'object' || Array.isArray(val)) throw new Error('Must be a mapping');
          delete val.credentials;
          e.target.classList.remove('bad');
          hint.className = 'hint';
          hint.textContent = 'OK';
          App.change((m) => { m.domains[di].extra = val; }, { key: 'dom' + di, full: false });
        } catch (err) {
          e.target.classList.add('bad');
          hint.className = 'hint err';
          hint.textContent = err.message.split('\n')[0];
        }
      },
    });
    return h('details', { open: !!text }, h('summary', { class: 'lbl' }, 'Domain'), h('div', { class: 'row' }, ta, hint));
  }

  function renderForm() {
    const box = $('#credForm');
    const scroll = box.scrollTop;
    box.textContent = '';
    const c = cred();
    if (!c) {
      box.append(h('div', { class: 'empty' }, 'Select a credential on the left or add a new one.'));
      return;
    }
    const [di, ci] = S.selCred;
    const len = S.model.domains[di].credentials.length;
    const live = (key, fn) => (e) => App.change((m) => fn(cred(m), e.target), { key: key + di + '.' + ci, full: false });

    box.append(
      h('h3', {}, 'Credential'),
      h('div', { class: 'actions' },
        h('button', { class: 'small', disabled: ci === 0, onclick: () => moveCred(-1) }, '↑ Up'),
        h('button', { class: 'small', disabled: ci === len - 1, onclick: () => moveCred(1) }, '↓ Down'),
        h('button', { class: 'small', onclick: duplicateCred }, 'Duplicate'),
        h('button', { class: 'small danger', onclick: deleteCred }, 'Delete')),
    );
    if (c.type === '__raw') {
      box.append(h('p', { class: 'muted' }, 'This entry does not have the "- <type>: {…}" shape and is kept unchanged.'));
      return;
    }
    const types = Array.from(new Set(Object.keys(C.CREDENTIAL_TEMPLATES).concat(c.type)));
    const scopes = Array.from(new Set(SCOPES.concat(c.cfg.scope ? [c.cfg.scope] : [])));
    box.append(
      h('div', { class: 'row' }, h('label', {}, 'Type'),
        h('select', { onchange: (e) => changeType(e.target.value) }, types.map((t) => h('option', { value: t, selected: t === c.type }, t)))),
      h('div', { class: 'row' }, h('label', {}, 'ID'),
        h('input', { type: 'text', id: 'cfId', value: c.cfg.id || '', spellcheck: false, oninput: live('cid', (x, t) => { x.cfg.id = t.value; }) })),
      h('div', { class: 'row' }, h('label', {}, 'Description'),
        h('input', { type: 'text', value: c.cfg.description || '', oninput: live('cdesc', (x, t) => { if (t.value) x.cfg.description = t.value; else delete x.cfg.description; }) })),
      h('div', { class: 'row' }, h('label', {}, 'Scope'),
        h('select', {
          onchange: (e) => App.change((m) => { cred(m).cfg.scope = e.target.value; }),
        }, (c.cfg.scope ? [] : [h('option', { value: '', selected: true }, '(not set)')]).concat(scopes.map((s) => h('option', { value: s, selected: s === c.cfg.scope }, s))))),
      h('fieldset', {}, h('legend', {}, 'Fields'), fieldEditor(c.cfg, '', 0)),
    );

    const keyIn = h('input', { type: 'text', placeholder: 'field (a.b.c for nested)', spellcheck: false });
    const valIn = h('input', { type: 'text', placeholder: 'value, e.g. ${JCASC_VAR}', spellcheck: false });
    const add = () => {
      const k = keyIn.value.trim();
      if (!k) return;
      App.change((m) => setPath(cred(m).cfg, k, valIn.value));
    };
    valIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    box.append(
      h('div', { class: 'row' }, h('label', {}, 'Add field'), h('div', { class: 'inline' }, keyIn, valIn, h('button', { class: 'small', onclick: add }, 'Add'))),
      h('div', { class: 'row' }, h('label', {}, 'Used by'), h('div', { class: 'usage', id: 'cfUsage' })),
      domainEditor(S.model.domains[di], di),
    );
    renderUsage();
    box.scrollTop = scroll;
  }

  App.renderCreds = function (full) {
    renderTable();
    if (full) renderForm();
    else renderUsage();
  };

  App.setupCreds = function () {
    const sel = $('#credAddType');
    Object.keys(C.CREDENTIAL_TEMPLATES).forEach((t) => sel.append(h('option', { value: t }, t)));
    $('#credAdd').addEventListener('click', () => addCredential(sel.value));
    $('#credFilter').addEventListener('input', (e) => { S.credQuery = e.target.value; renderTable(); });
  };
})();
