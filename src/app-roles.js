/* Roles (role-strategy plugin): users × roles matrix, roles × permissions matrix, role and principal editors. */
(function () {
  'use strict';
  const C = window.JcascCore;
  const App = window.App;
  const { S, h, $, $$ } = App;

  const KIND_ICON = { user: '👤', group: '👥', ambiguous: '❔' };
  const TYPE_LABEL = { global: 'Global', items: 'Items', agents: 'Agents' };
  const KNOWN_KEYS = ['name', 'pattern', 'permissions', 'entries', 'assignments'];

  const auth = (m) => (m || S.model).auth;
  const role = (m, sel) => {
    const s = sel || S.selRole;
    if (!s) return null;
    const list = auth(m).roles[s[0]];
    return list ? list[s[1]] || null : null;
  };
  const readOnly = () => auth().kind === 'other';
  const perms = (r) => (Array.isArray(r.cfg.permissions) ? r.cfg.permissions.map(String) : []);
  const roleLabel = (t, r) => `${TYPE_LABEL[t] || t} · ${r.cfg.name || '(unnamed)'}`;

  function shownTypes() {
    const a = auth();
    return Array.from(new Set(C.ROLE_TYPES.concat(Object.keys(a.roles))));
  }

  function columns() {
    const out = [];
    for (const t of shownTypes()) (auth().roles[t] || []).forEach((r, i) => out.push({ t, i, r }));
    return out;
  }

  const KIND_ORDER = { group: 0, user: 1, ambiguous: 2 };

  function principals() {
    const list = C.listPrincipals(auth());
    const keys = new Set(list.map((p) => p.key));
    S.pendingPrincipals = S.pendingPrincipals.filter((k) => !keys.has(k));
    for (const k of S.pendingPrincipals) {
      const p = C.parsePrincipalKey(k);
      list.push({ key: k, kind: p.kind, sid: p.sid, roles: [], pending: true });
    }
    return list.sort((a, b) => (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3) || App.ci(a.sid, b.sid));
  }

  function levelOf(match) {
    let lvl = '';
    for (const it of S.issues) {
      if (it.area !== 'roles' || !it.target || !match(it.target)) continue;
      if (it.level === 'error') return 'error';
      if (it.level === 'warn') lvl = 'warn';
      else if (!lvl) lvl = 'info';
    }
    return lvl;
  }
  const roleLevel = (t, i) => levelOf((x) => x.role && x.role[0] === t && x.role[1] === i);
  const principalLevel = (key) => levelOf((x) => x.principal === key);
  const dot = (lvl) => (lvl ? h('span', { class: 'lv ' + lvl }) : null);
  const put = (box, ...kids) => box.append(...kids.filter((k) => k != null && k !== false));

  // ---------- selection ----------
  App.selectRole = function (t, i) {
    S.mode = 'roles';
    S.selRole = [t, i];
    S.formTarget = 'role';
    App.render(true);
  };

  App.selectPrincipal = function (key) {
    S.mode = 'roles';
    S.selPrincipal = key;
    S.formTarget = 'principal';
    App.render(true);
  };

  // ---------- mutations ----------
  function ensureRoleBased(m, type) {
    const a = m.auth;
    if (a.kind === 'none') a.kind = 'roleBased';
    if (type && !a.types.includes(type)) {
      a.types = C.ROLE_TYPES.filter((t) => a.types.includes(t) || t === type)
        .concat(a.types.filter((t) => !C.ROLE_TYPES.includes(t)));
    }
    if (type && !a.roles[type]) a.roles[type] = [];
  }

  function uniqueName(list, base) {
    const names = new Set(list.map((r) => r.cfg.name));
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  function addRole(type) {
    App.change((m) => {
      ensureRoleBased(m, type);
      const list = m.auth.roles[type];
      list.push({
        cfg: { name: uniqueName(list, 'new-role'), pattern: '.*', permissions: [type === 'global' ? 'Overall/Read' : type === 'agents' ? 'Agent/Build' : 'Job/Read'] },
        space: false,
      });
      S.selRole = [type, list.length - 1];
      S.formTarget = 'role';
    });
    setTimeout(() => { const el = $('#rfName'); if (el) { el.focus(); el.select(); } }, 0);
  }

  function toggleMember(t, i, key, on) {
    App.change((m) => {
      C.setRoleMember(m.auth.roles[t][i], C.parsePrincipalKey(key), on);
    });
  }

  function togglePermission(t, i, p, on) {
    App.change((m) => {
      const r = m.auth.roles[t][i];
      const list = perms(r);
      if (on && !list.includes(p)) list.push(p);
      if (!on) list.splice(0, list.length, ...list.filter((x) => x !== p));
      r.cfg.permissions = list;
    });
  }

  function moveRole(dir) {
    const [t, i] = S.selRole;
    const j = i + dir;
    App.change((m) => {
      const list = m.auth.roles[t];
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      S.selRole = [t, j];
    });
  }

  function duplicateRole() {
    const [t, i] = S.selRole;
    App.change((m) => {
      const list = m.auth.roles[t];
      const copy = C.clone(list[i]);
      copy.cfg.name = uniqueName(list, (copy.cfg.name || 'role') + '-copy');
      list.splice(i + 1, 0, copy);
      S.selRole = [t, i + 1];
    });
  }

  function deleteRole() {
    const [t, i] = S.selRole;
    const r = role();
    const n = C.roleMembers(r.cfg).length;
    if (!confirm(`Delete ${t} role "${r.cfg.name}"${n ? ` with ${n} member(s)` : ''}?`)) return;
    App.change((m) => {
      m.auth.roles[t].splice(i, 1);
      S.selRole = m.auth.roles[t].length ? [t, Math.min(i, m.auth.roles[t].length - 1)] : null;
    });
  }

  function changeRoleType(nt) {
    const [t, i] = S.selRole;
    if (nt === t) return;
    App.change((m) => {
      ensureRoleBased(m, nt);
      const [r] = m.auth.roles[t].splice(i, 1);
      r.cfg.name = uniqueName(m.auth.roles[nt], r.cfg.name || 'role');
      m.auth.roles[nt].push(r);
      S.selRole = [nt, m.auth.roles[nt].length - 1];
    });
  }

  function sameMember(a, b) { return a.kind === b.kind && a.sid === b.sid; }

  /** Replace a principal in every role, keeping its position in each member list. */
  function renamePrincipal(oldKey, kind, sid) {
    sid = sid.trim();
    if (!sid) return;
    const from = C.parsePrincipalKey(oldKey);
    const to = { kind, sid };
    const newKey = C.principalKey(to);
    if (newKey === oldKey) return;
    if (C.listPrincipals(auth()).some((p) => p.key === newKey)
      && !confirm(`${sid} already exists. Merge ${from.sid} into it?`)) { App.render(true); return; }
    if (S.pendingPrincipals.includes(oldKey)) {
      S.pendingPrincipals = S.pendingPrincipals.map((k) => (k === oldKey ? newKey : k));
      S.selPrincipal = newKey;
      App.render(true);
      return;
    }
    App.change((m) => {
      for (const t of Object.keys(m.auth.roles)) {
        for (const r of m.auth.roles[t]) {
          if (!C.isMember(r, oldKey)) continue;
          const already = C.isMember(r, newKey);
          if (Array.isArray(r.cfg.entries)) {
            const out = [];
            for (const e of r.cfg.entries) {
              const mem = C.roleMembers({ entries: [e] })[0];
              if (!sameMember(mem, from)) out.push(e);
              else if (!already) out.push({ [to.kind]: to.sid });
            }
            r.cfg.entries = out;
          } else {
            C.setRoleMember(r, from, false);
            C.setRoleMember(r, to, true);
          }
        }
      }
      S.selPrincipal = newKey;
    });
  }

  function removePrincipal(key) {
    const p = C.parsePrincipalKey(key);
    S.pendingPrincipals = S.pendingPrincipals.filter((k) => k !== key);
    const n = C.listPrincipals(auth()).find((x) => x.key === key);
    if (n && !confirm(`Remove ${p.sid} from all ${n.roles.length} role(s)?`)) return;
    App.change((m) => {
      for (const t of Object.keys(m.auth.roles)) for (const r of m.auth.roles[t]) C.setRoleMember(r, p, false);
      S.selPrincipal = null;
    });
  }

  function copyRoles(fromKey, toKey) {
    App.change((m) => {
      const to = C.parsePrincipalKey(toKey);
      for (const t of Object.keys(m.auth.roles)) {
        for (const r of m.auth.roles[t]) if (C.isMember(r, fromKey)) C.setRoleMember(r, to, true);
      }
    });
  }

  function addPrincipal(kind, sid, copyFrom) {
    sid = sid.trim();
    if (!sid) return;
    const key = C.principalKey({ kind, sid });
    const exists = C.listPrincipals(auth()).some((p) => p.key === key);
    if (!exists && !S.pendingPrincipals.includes(key)) S.pendingPrincipals.push(key);
    S.selPrincipal = key;
    S.formTarget = 'principal';
    if (copyFrom) copyRoles(copyFrom, key);
    else App.render(true);
  }

  // ---------- matrix: users × roles ----------
  function keepScroll(box, fn) {
    const top = box.scrollTop;
    const left = box.scrollLeft;
    fn();
    box.scrollTop = top;
    box.scrollLeft = left;
  }

  function roleHeaderCell(c) {
    const sel = S.formTarget === 'role' && S.selRole && S.selRole[0] === c.t && S.selRole[1] === c.i;
    const n = C.roleMembers(c.r.cfg).length;
    return h('th', {
      class: 'rolecol' + (sel ? ' sel' : ''),
      title: `${roleLabel(c.t, c.r)}\npattern: ${c.r.cfg.pattern ?? '(none)'}\n${perms(c.r).join('\n')}`,
      onclick: () => App.selectRole(c.t, c.i),
    },
    h('div', { class: 'rname' }, dot(roleLevel(c.t, c.i)), c.r.cfg.name || '(unnamed)'),
    c.t !== 'global' ? h('div', { class: 'rpat' }, c.r.cfg.pattern ?? '') : null,
    h('div', { class: 'rmeta' }, `${n} member${n === 1 ? '' : 's'}`));
  }

  function typeHeaderRow(cols, lead) {
    const groups = [];
    for (const c of cols) {
      const g = groups[groups.length - 1];
      if (g && g.t === c.t) g.n++;
      else groups.push({ t: c.t, n: 1 });
    }
    return h('tr', { class: 'types' }, lead, groups.map((g) => h('th', { colspan: g.n, class: 'typehead t-' + g.t.replace(/ \+ /g, '-') }, g.t.split(' + ').map((x) => TYPE_LABEL[x] || x).join(' + '))));
  }

  /** Group roles sharing a name (e.g. global "qa" + items "qa") into one column. */
  function mergedColumns(cols) {
    const byName = new Map();
    for (const c of cols) {
      const k = c.r.cfg.name || `\u0000${c.t}:${c.i}`;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(c);
    }
    return Array.from(byName.values()).map((parts) => ({
      parts,
      t: parts.map((p) => p.t).join(' + '),
      r: parts[0].r,
    }));
  }

  function toggleMerged(parts, key, on) {
    App.change((m) => {
      const p = C.parsePrincipalKey(key);
      for (const c of parts) C.setRoleMember(m.auth.roles[c.t][c.i], p, on);
    });
  }

  function mergedHeaderCell(g) {
    if (g.parts.length === 1) return roleHeaderCell(g.parts[0]);
    const sel = S.formTarget === 'role' && S.selRole && g.parts.some((c) => S.selRole[0] === c.t && S.selRole[1] === c.i);
    const members = new Set();
    for (const c of g.parts) for (const m of C.roleMembers(c.r.cfg)) members.add(C.principalKey(m));
    const lvl = g.parts.map((c) => roleLevel(c.t, c.i)).find((l) => l === 'error') || g.parts.map((c) => roleLevel(c.t, c.i)).find(Boolean) || '';
    const pats = g.parts.filter((c) => c.t !== 'global').map((c) => c.r.cfg.pattern ?? '');
    return h('th', {
      class: 'rolecol merged' + (sel ? ' sel' : ''),
      onclick: () => App.selectRole(g.parts[0].t, g.parts[0].i),
      title: g.parts.map((c) => `${roleLabel(c.t, c.r)}${c.t !== 'global' ? `  pattern: ${c.r.cfg.pattern ?? ''}` : ''}\n  ${perms(c.r).join(', ')}`).join('\n\n'),
    },
    h('div', { class: 'rname' }, dot(lvl), g.r.cfg.name || '(unnamed)'),
    pats.length ? h('div', { class: 'rpat' }, pats.join(' · ')) : null,
    h('div', { class: 'rparts' }, g.parts.map((c) => h('a', {
      class: 'rpart t-' + c.t,
      title: `Open ${roleLabel(c.t, c.r)}`,
      onclick: (e) => { e.stopPropagation(); App.selectRole(c.t, c.i); },
    }, c.t))),
    h('div', { class: 'rmeta' }, `${members.size} member${members.size === 1 ? '' : 's'}`));
  }

  function renderUsersMatrix(box) {
    const roleCols = columns();
    const merge = S.mergeRoles;
    const cols = merge ? mergedColumns(roleCols) : roleCols.map((c) => ({ parts: [c], t: c.t, r: c.r }));
    const U = App.universe();
    const q = S.principalQuery.trim().toLowerCase();
    const all = principals();
    const list = q ? all.filter((p) => p.sid.toLowerCase().includes(q)) : all;
    const ro = readOnly();
    const selCol = S.formTarget === 'role' && S.selRole ? S.selRole.join(':') : null;

    const head = h('thead', {},
      typeHeaderRow(cols, h('th', { rowspan: 2, class: 'corner' }, `Users & groups (${list.length}${q ? '/' + all.length : ''})`)),
      h('tr', {}, cols.map(mergedHeaderCell), h('th', { class: 'rolecol summary', rowspan: 1, title: 'Jobs this principal can read (from the jobs folder)' }, h('div', { class: 'rname' }, 'Jobs'))));
    head.firstChild.append(h('th', { class: 'typehead' }, ''));

    const body = h('tbody', {}, list.map((p) => {
      const acc = C.principalAccess(auth(), p.key, U);
      const readable = acc.admin ? U.length : Array.from(acc.jobs.values()).filter((s) => s.has('Job/Read')).length;
      const canRead = acc.admin || acc.global.has('Overall/Read');
      const sel = S.formTarget === 'principal' && S.selPrincipal === p.key;
      return h('tr', { class: (sel ? 'sel' : '') + (p.pending ? ' pending' : '') },
        h('th', { class: 'pname', title: `${p.kind}: ${p.sid}`, onclick: () => App.selectPrincipal(p.key) },
          h('span', { class: 'kind' }, KIND_ICON[p.kind] || '?'), dot(principalLevel(p.key)), p.sid),
        cols.map((g) => {
          const n = g.parts.filter((c) => C.isMember(c.r, p.key)).length;
          const on = n === g.parts.length;
          const some = n > 0 && !on;
          const isSel = selCol && g.parts.some((c) => selCol === c.t + ':' + c.i);
          const box = h('input', {
            type: 'checkbox',
            checked: on,
            disabled: ro,
            title: g.parts.length > 1
              ? `${p.sid} — ${g.r.cfg.name}: ${g.parts.map((c) => `${c.t} ${C.isMember(c.r, p.key) ? '✓' : '✗'}`).join(', ')}`
              : `${p.sid} — ${roleLabel(g.t, g.r)}`,
            onchange: (e) => toggleMerged(g.parts, p.key, e.target.checked),
          });
          box.indeterminate = some;
          return h('td', { class: 'cell' + (on ? ' on' : '') + (some ? ' some' : '') + (isSel ? ' selcol' : '') }, box);
        }),
        h('td', { class: 'jobs' + (canRead ? '' : ' warn'), title: canRead ? '' : 'No Overall/Read — cannot see anything' },
          acc.admin ? 'admin' : (U.length ? `${readable}/${U.length}` : (canRead ? '✓' : '—'))));
    }));

    const kindSel = h('select', {}, C.PRINCIPAL_KINDS.map((k) => h('option', { value: k }, k)));
    const sidIn = h('input', { type: 'text', placeholder: 'user id / e-mail or group', spellcheck: false });
    const copySel = h('select', { title: 'Give the new principal the same roles as…' },
      h('option', { value: '' }, 'no roles'), all.map((p) => h('option', { value: p.key }, `same roles as ${p.sid}`)));
    const add = () => addPrincipal(kindSel.value, sidIn.value, copySel.value);
    sidIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    const foot = h('tfoot', {}, h('tr', {}, h('th', { class: 'pname add', colspan: cols.length + 2 },
      h('div', { class: 'inline' }, kindSel, sidIn, copySel, h('button', { class: 'small', disabled: ro, onclick: add }, '+ Add')))));

    box.append(h('table', { class: 'matrix' }, head, body, ro ? null : foot));
    if (!list.length) box.append(h('div', { class: 'muted', style: { padding: '10px' } }, q ? 'No matches.' : 'No users or groups yet.'));
  }

  // ---------- matrix: roles × permissions ----------
  function permissionRows(cols) {
    const seen = new Set();
    const out = [];
    const push = (p) => { if (!seen.has(p)) { seen.add(p); out.push(p); } };
    const types = new Set(cols.map((c) => c.t));
    for (const t of C.ROLE_TYPES) if (types.has(t)) C.PERMISSIONS[t].forEach(push);
    for (const c of cols) perms(c.r).forEach(push);
    const cat = (p) => p.split('/')[0];
    const catOrder = [];
    for (const p of out) if (!catOrder.includes(cat(p))) catOrder.push(cat(p));
    return out.sort((a, b) => catOrder.indexOf(cat(a)) - catOrder.indexOf(cat(b)));
  }

  function renderPermsMatrix(box) {
    const cols = columns();
    const rows = permissionRows(cols);
    const ro = readOnly();
    const q = S.principalQuery.trim().toLowerCase();
    const shown = q ? rows.filter((p) => p.toLowerCase().includes(q)) : rows;
    const selCol = S.formTarget === 'role' && S.selRole ? S.selRole.join(':') : null;
    const head = h('thead', {},
      typeHeaderRow(cols, h('th', { rowspan: 2, class: 'corner' }, `Permissions (${shown.length})`)),
      h('tr', {}, cols.map(roleHeaderCell)));
    let lastCat = null;
    const body = h('tbody', {});
    for (const p of shown) {
      const [catName, perm] = [p.split('/')[0], p.split('/').slice(1).join('/')];
      if (catName !== lastCat) {
        body.append(h('tr', { class: 'cat' }, h('th', { class: 'pname', colspan: cols.length + 1 }, catName)));
        lastCat = catName;
      }
      body.append(h('tr', {},
        h('th', { class: 'pname perm', title: p }, perm || p),
        cols.map((c) => {
          const on = perms(c.r).includes(p);
          const applicable = (C.PERMISSIONS[c.t] || []).includes(p);
          return h('td', { class: 'cell' + (on ? ' on' : '') + (applicable ? '' : ' na') + (selCol === c.t + ':' + c.i ? ' selcol' : '') },
            applicable || on ? h('input', {
              type: 'checkbox',
              checked: on,
              disabled: ro,
              title: `${roleLabel(c.t, c.r)} — ${p}${applicable ? '' : ' (not applicable to ' + c.t + ' roles)'}`,
              onchange: (e) => togglePermission(c.t, c.i, p, e.target.checked),
            }) : null);
        })));
    }
    box.append(h('table', { class: 'matrix perms' }, head, body));
  }

  function renderMatrix() {
    const box = $('#rolesMatrix');
    $$('#rolesViewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.rv === S.rolesView));
    const mr = $('#mergeRoles');
    mr.checked = S.mergeRoles;
    mr.parentElement.hidden = S.rolesView !== 'users';
    keepScroll(box, () => {
      box.textContent = '';
      const a = auth();
      if (a.kind === 'other') {
        const kind = a.raw && typeof a.raw === 'object' ? Object.keys(a.raw)[0] : String(a.raw);
        box.append(h('div', { class: 'jempty' },
          h('p', {}, 'authorizationStrategy is ', h('code', {}, kind), ', not roleBased.'),
          h('button', {
            onclick: () => {
              if (!confirm('Replace the current authorizationStrategy with an empty roleBased one?')) return;
              App.change((m) => { m.auth = Object.assign(m.auth, { kind: 'roleBased', raw: undefined }); ensureRoleBased(m, 'global'); });
            },
          }, 'Replace with roleBased')));
        return;
      }
      if (!columns().length) {
        box.append(h('div', { class: 'jempty' },
          a.kind === 'none' ? 'No authorizationStrategy in this file. ' : 'No roles defined. ',
          h('button', { onclick: () => addRole('global') }, '+ Add a global role')));
        return;
      }
      if (S.rolesView === 'perms') renderPermsMatrix(box);
      else renderUsersMatrix(box);
    });
  }

  // ---------- role form ----------
  function patternInfo(r, t) {
    const box = h('div', { class: 'hint', id: 'rfPatternHint' });
    if (t === 'global') {
      box.textContent = 'Ignored for global roles (Jenkins always uses ".*").';
      return box;
    }
    const U = App.universe();
    const m = C.roleMatches(r, U);
    if (m.error) { box.className = 'hint err'; box.textContent = m.error; return box; }
    if (t === 'agents') { box.textContent = 'Matched against agent names (not previewed).'; return box; }
    box.textContent = U.length ? `Matches ${m.jobs.length} of ${U.length} job(s)` : 'Pick the jobs folder to preview matching jobs.';
    return box;
  }

  function matchedJobs(r, t) {
    if (t !== 'items') return null;
    const m = C.roleMatches(r, App.universe());
    if (m.error || !m.jobs.length) return null;
    return h('details', { id: 'rfJobs', open: m.jobs.length <= 15 },
      h('summary', { class: 'lbl' }, `Matched jobs (${m.jobs.length})`),
      h('div', { class: 'chips' }, m.jobs.map((j) => h('span', { class: 'chip' }, j))));
  }

  function refreshPattern() {
    const r = role();
    if (!r) return;
    const old = $('#rfPatternHint');
    if (old) old.replaceWith(patternInfo(r, S.selRole[0]));
    const oldJobs = $('#rfJobs');
    const next = matchedJobs(r, S.selRole[0]);
    if (oldJobs && next) { next.open = oldJobs.open; oldJobs.replaceWith(next); } else if (oldJobs) oldJobs.remove();
    else if (next) { const anchor = $('#rfPatternRow'); if (anchor) anchor.after(next); }
  }

  function otherPropsEditor(r) {
    const extra = {};
    for (const [k, v] of Object.entries(r.cfg)) if (!KNOWN_KEYS.includes(k)) extra[k] = v;
    const text = Object.keys(extra).length ? window.YAML.stringify(extra) : '';
    const hint = h('div', { class: 'hint' }, 'Other role properties (e.g. description, templateName), as YAML.');
    const ta = h('textarea', {
      rows: Math.min(10, Math.max(2, text.split('\n').length)),
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
          const x = role(m);
          const next = {};
          for (const [k, v] of Object.entries(x.cfg)) {
            if (KNOWN_KEYS.includes(k)) next[k] = v;
            else if (k in parsed) next[k] = parsed[k];
          }
          for (const [k, v] of Object.entries(parsed)) if (!(k in next) && !KNOWN_KEYS.includes(k)) next[k] = v;
          x.cfg = next;
        }, { key: 'radv' + S.selRole.join(':'), full: false });
      },
    });
    ta.value = text;
    return h('details', { open: !!text }, h('summary', { class: 'lbl' }, 'Other properties'), h('div', { class: 'row' }, ta, hint));
  }

  function permissionEditor(r, t) {
    const have = perms(r);
    const all = (C.PERMISSIONS[t] || []).slice();
    for (const p of have) if (!all.includes(p)) all.push(p);
    const byCat = new Map();
    for (const p of all) {
      const c = p.split('/')[0];
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(p);
    }
    const [rt, ri] = S.selRole;
    return h('fieldset', {}, h('legend', {}, `Permissions (${have.length})`),
      Array.from(byCat.entries()).map(([cat, ps]) => h('div', { class: 'permcat' },
        h('div', { class: 'catname' }, cat,
          h('button', { class: 'link', disabled: readOnly(), title: 'Toggle all in this category', onclick: () => {
            const allOn = ps.every((p) => have.includes(p));
            App.change((m) => {
              const x = role(m);
              let list = perms(x);
              if (allOn) list = list.filter((p) => !ps.includes(p));
              else for (const p of ps) if (!list.includes(p)) list.push(p);
              x.cfg.permissions = list;
            });
          } }, 'all')),
        h('div', { class: 'perms' }, ps.map((p) => {
          const known = (C.PERMISSIONS[t] || []).includes(p);
          return h('label', { class: 'perm' + (known ? '' : ' unknown'), title: known ? p : `${p} — not applicable to ${t} roles` },
            h('input', { type: 'checkbox', checked: have.includes(p), disabled: readOnly(), onchange: (e) => togglePermission(rt, ri, p, e.target.checked) }),
            p.split('/').slice(1).join('/') || p);
        })))));
  }

  function membersEditor(r) {
    const [t, i] = S.selRole;
    const members = C.roleMembers(r.cfg);
    const kindSel = h('select', {}, C.PRINCIPAL_KINDS.map((k) => h('option', { value: k }, k)));
    const others = C.listPrincipals(auth()).filter((p) => !C.isMember(r, p.key));
    const listId = 'rfPrincipals';
    const sidIn = h('input', { type: 'text', placeholder: 'user id / e-mail or group', spellcheck: false, list: listId });
    const add = () => {
      let sid = sidIn.value.trim();
      if (!sid) return;
      const known = others.find((p) => p.sid === sid);
      toggleMember(t, i, C.principalKey({ kind: known ? known.kind : kindSel.value, sid }), true);
      setTimeout(() => { const el = $('#roleForm input[list]'); if (el) el.focus(); }, 0);
    };
    sidIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    return h('fieldset', {}, h('legend', {}, `Members (${members.length})`),
      h('div', { class: 'chips' }, members.map((mem) => {
        const key = C.principalKey(mem);
        return h('span', { class: 'chipjob member' },
          h('span', { class: 'link', title: 'Show this principal', onclick: () => App.selectPrincipal(key) }, (KIND_ICON[mem.kind] || '?') + ' ' + mem.sid),
          h('button', { class: 'icon', disabled: readOnly(), title: 'Remove from role', onclick: () => toggleMember(t, i, key, false) }, '✕'));
      }), members.length ? null : h('span', { class: 'muted' }, 'No members.')),
      readOnly() ? null : h('div', { class: 'inline', style: { marginTop: '6px' } }, kindSel, sidIn,
        h('datalist', { id: listId }, others.map((p) => h('option', { value: p.sid }))),
        h('button', { class: 'small', onclick: add }, 'Add')));
  }

  function renderRoleForm(box) {
    const r = role();
    if (!r) {
      box.append(h('div', { class: 'empty' }, 'Click a role column header or a user name in the matrix.'));
      return;
    }
    const [t, i] = S.selRole;
    const len = auth().roles[t].length;
    const ro = readOnly();
    const live = (key, fn) => (e) => App.change((m) => fn(role(m), e.target), { key: key + t + i, full: false });
    put(box,
      h('h3', {}, 'Role', h('span', { class: 'badge t-' + t }, TYPE_LABEL[t] || t)),
      ro ? null : h('div', { class: 'actions' },
        h('button', { class: 'small', disabled: i === 0, onclick: () => moveRole(-1) }, '← Move'),
        h('button', { class: 'small', disabled: i === len - 1, onclick: () => moveRole(1) }, 'Move →'),
        h('button', { class: 'small', onclick: duplicateRole }, 'Duplicate'),
        h('button', { class: 'small danger', onclick: deleteRole }, 'Delete')),
      h('div', { class: 'row' }, h('label', {}, 'Type'),
        h('select', { disabled: ro, onchange: (e) => changeRoleType(e.target.value) },
          Array.from(new Set(C.ROLE_TYPES.concat(t))).map((x) => h('option', { value: x, selected: x === t }, TYPE_LABEL[x] || x)))),
      h('div', { class: 'row' }, h('label', {}, 'Name'),
        h('input', { type: 'text', id: 'rfName', value: r.cfg.name || '', disabled: ro, spellcheck: false, oninput: live('rname', (x, el) => { x.cfg.name = el.value; }) })),
      h('div', { class: 'row', id: 'rfPatternRow' }, h('label', {}, 'Pattern'),
        h('input', {
          type: 'text', value: r.cfg.pattern ?? '', disabled: ro || t === 'global', spellcheck: false, placeholder: '.*',
          oninput: live('rpat', (x, el) => { x.cfg.pattern = el.value; }),
        }),
        patternInfo(r, t)),
      matchedJobs(r, t),
      permissionEditor(r, t),
      membersEditor(r),
      otherPropsEditor(r),
    );
  }

  // ---------- principal form ----------
  function renderPrincipalForm(box) {
    const key = S.selPrincipal;
    const all = principals();
    const p = all.find((x) => x.key === key);
    if (!p) {
      box.append(h('div', { class: 'empty' }, 'Click a role column header or a user name in the matrix.'));
      return;
    }
    const ro = readOnly();
    const U = App.universe();
    const acc = C.principalAccess(auth(), key, U);
    const kindSel = h('select', { disabled: ro }, C.PRINCIPAL_KINDS.map((k) => h('option', { value: k, selected: k === p.kind }, k)));
    const sidIn = h('input', { type: 'text', value: p.sid, disabled: ro, spellcheck: false, title: 'Renames this principal in every role (on Enter or leaving the field)' });
    const commit = () => renamePrincipal(key, kindSel.value, sidIn.value);
    sidIn.addEventListener('change', commit);
    kindSel.addEventListener('change', commit);

    put(box,
      h('h3', {}, KIND_ICON[p.kind] || '?', p.sid),
      ro ? null : h('div', { class: 'actions' },
        h('button', { class: 'small danger', onclick: () => removePrincipal(key) }, 'Remove from all roles')),
      h('div', { class: 'row' }, h('label', {}, 'Kind / ID'), h('div', { class: 'inline' }, kindSel, sidIn),
        h('div', { class: 'hint' }, 'Editing renames it in every role.')),
    );

    // Roles, grouped by type, with checkboxes.
    for (const t of shownTypes()) {
      const list = auth().roles[t] || [];
      if (!list.length) continue;
      box.append(h('fieldset', {}, h('legend', {}, `${TYPE_LABEL[t] || t} roles`),
        list.map((r, i) => h('label', { class: 'rolepick' },
          h('input', { type: 'checkbox', checked: C.isMember(r, key), disabled: ro, onchange: (e) => toggleMember(t, i, key, e.target.checked) }),
          h('span', { class: 'link', onclick: (e) => { e.preventDefault(); App.selectRole(t, i); } }, r.cfg.name || '(unnamed)'),
          t !== 'global' ? h('code', {}, r.cfg.pattern ?? '') : null,
          h('span', { class: 'muted' }, perms(r).map((x) => x.split('/').pop()).join(', '))))));
    }

    const others = all.filter((x) => x.key !== key && x.roles.length);
    if (!ro && others.length) {
      const sel = h('select', {}, others.map((x) => h('option', { value: x.key }, x.sid)));
      box.append(h('div', { class: 'row' }, h('label', {}, 'Add all roles of'),
        h('div', { class: 'inline' }, sel, h('button', { class: 'small', onclick: () => copyRoles(sel.value, key) }, 'Copy'))));
    }

    // Effective access.
    const g = Array.from(acc.global);
    const canRead = acc.admin || acc.global.has('Overall/Read');
    const eff = h('fieldset', {}, h('legend', {}, 'Effective access'));
    eff.append(h('div', { class: 'row' }, h('label', {}, 'Global'),
      h('div', { class: 'chips' }, g.length ? g.map((x) => h('span', { class: 'chip' + (x === 'Overall/Administer' ? ' admin' : '') }, x)) : h('span', { class: 'muted' }, 'none'))));
    if (!canRead) eff.append(h('div', { class: 'warnbox' }, 'No global role grants Overall/Read — this principal cannot see Jenkins at all.'));
    if (acc.admin) {
      eff.append(h('div', { class: 'muted' }, 'Overall/Administer — full access to everything.'));
    } else if (U.length) {
      const jobs = U.filter((j) => acc.jobs.has(j) && acc.jobs.get(j).size);
      const byJob = new Map();
      for (const ir of acc.itemRoles) {
        const r = auth().roles.items[ir.index];
        for (const j of ir.jobs) {
          if (!byJob.has(j)) byJob.set(j, []);
          byJob.get(j).push(r.cfg.name);
        }
      }
      eff.append(h('div', { class: 'row' }, h('label', {}, `Jobs (${jobs.length} of ${U.length})`),
        jobs.length ? h('table', { class: 'eff' },
          h('tbody', {}, jobs.map((j) => h('tr', {},
            h('td', { class: 'job' }, j),
            h('td', { class: 'pp' }, Array.from(acc.jobs.get(j)).map((x) => x.split('/').pop()).sort().join(', ')),
            h('td', { class: 'muted' }, (byJob.get(j) || ['global']).join(', ')))))) : h('span', { class: 'muted' }, 'No jobs.')));
    }
    if (acc.agentRoles.length) {
      eff.append(h('div', { class: 'row' }, h('label', {}, 'Agents'),
        h('div', { class: 'chips' }, acc.agentRoles.map((a) => {
          const r = auth().roles[a.type][a.index];
          return h('span', { class: 'chip' }, `${r.cfg.name} (${r.cfg.pattern ?? ''})`);
        }))));
    }
    box.append(eff);
  }

  function renderForm() {
    const box = $('#roleForm');
    const scroll = box.scrollTop;
    box.textContent = '';
    if (S.formTarget === 'principal') renderPrincipalForm(box);
    else renderRoleForm(box);
    box.scrollTop = scroll;
  }

  App.renderRoles = function (full) {
    if (!S.formTarget) S.formTarget = S.selPrincipal && !S.selRole ? 'principal' : 'role';
    if (!S.selRole && !S.selPrincipal) {
      const c = columns()[0];
      if (c) S.selRole = [c.t, c.i];
    }
    renderMatrix();
    if (full) renderForm();
    else if (S.formTarget === 'role') refreshPattern();
  };

  App.setupRoles = function () {
    const sel = $('#roleAddType');
    C.ROLE_TYPES.forEach((t) => sel.append(h('option', { value: t }, TYPE_LABEL[t])));
    $('#roleAdd').addEventListener('click', () => { if (!readOnly()) addRole(sel.value); });
    $('#principalFilter').addEventListener('input', (e) => { S.principalQuery = e.target.value; renderMatrix(); });
    $('#mergeRoles').addEventListener('change', (e) => { S.mergeRoles = e.target.checked; renderMatrix(); App.persistSoon(); });
    $$('#rolesViewSeg button').forEach((b) => {
      b.addEventListener('click', () => { S.rolesView = b.dataset.rv; renderMatrix(); App.persistSoon(); });
    });
  };
})();
