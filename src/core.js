/*
 * Pure logic for the JCasC visual editor: parsing, YAML regeneration,
 * view matching, job/credential scanning and linting.
 * Works both in the browser (window.JcascCore, needs window.YAML) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('yaml'));
  } else {
    root.JcascCore = factory(root.YAML);
  }
})(typeof self !== 'undefined' ? self : this, function (YAML) {
  'use strict';

  const PATHS = {
    views: ['jenkins', 'views'],
    tabBar: ['jenkins', 'viewsTabBar'],
    creds: ['credentials', 'system', 'domainCredentials'],
    auth: ['jenkins', 'authorizationStrategy'],
  };

  const ROLE_TYPES = ['global', 'items', 'agents'];
  const PRINCIPAL_KINDS = ['user', 'group', 'ambiguous'];

  const JOB_PERMS = ['Job/Build', 'Job/Cancel', 'Job/Configure', 'Job/Create', 'Job/Delete', 'Job/Discover', 'Job/ExtendedRead', 'Job/Move', 'Job/Read', 'Job/Workspace'];
  const RUN_PERMS = ['Run/Delete', 'Run/Replay', 'Run/Update'];
  const CRED_PERMS = ['Credentials/Create', 'Credentials/Delete', 'Credentials/ManageDomains', 'Credentials/Update', 'Credentials/View'];
  const AGENT_PERMS = ['Agent/Build', 'Agent/Configure', 'Agent/Connect', 'Agent/Create', 'Agent/Delete', 'Agent/Disconnect', 'Agent/ExtendedRead'];
  /** Permissions offered per role type (role-strategy plugin). Unknown ones found in the file are kept. */
  const PERMISSIONS = {
    global: ['Overall/Administer', 'Overall/Manage', 'Overall/SystemRead', 'Overall/Read']
      .concat(CRED_PERMS, AGENT_PERMS, JOB_PERMS, RUN_PERMS,
        ['View/Configure', 'View/Create', 'View/Delete', 'View/Read', 'SCM/Tag',
          'Lockable Resources/Reserve', 'Lockable Resources/Unlock', 'Lockable Resources/View']),
    items: CRED_PERMS.concat(JOB_PERMS, RUN_PERMS, ['SCM/Tag']),
    agents: AGENT_PERMS.slice(),
  };

  const KNOWN_COLUMNS = [
    'status', 'weather', 'jobName', 'lastSuccess', 'lastFailure', 'lastStable',
    'lastDuration', 'buildButton', 'jobDescription', 'favoriteColumn', 'lastBuildConsoleColumn',
  ];

  const VIEW_TYPES = ['list', 'all', 'myView'];

  const CREDENTIAL_TEMPLATES = {
    string: { scope: 'GLOBAL', id: '', description: '', secret: '${JCASC_CREDENTIALS_}' },
    usernamePassword: { scope: 'GLOBAL', id: '', description: '', username: '', password: '${JCASC_CREDENTIALS_}' },
    basicSSHUserPrivateKey: {
      scope: 'GLOBAL', id: '', description: '', username: 'git',
      privateKeySource: { directEntry: { privateKey: '${JCASC_CREDENTIALS_}' } },
    },
    file: { scope: 'GLOBAL', id: '', description: '', fileName: '', secretBytes: '${JCASC_CREDENTIALS_}' },
    vaultAppRoleCredential: { scope: 'GLOBAL', id: '', description: '', path: 'approle', roleId: '${}', secretId: '${}' },
    vaultTokenCredential: { scope: 'GLOBAL', id: '', description: '', token: '${}' },
    gitLabApiTokenImpl: { scope: 'GLOBAL', id: '', description: '', apiToken: '${JCASC_CREDENTIALS_}' },
    aws: { scope: 'GLOBAL', id: '', description: '', accessKey: '${}', secretKey: '${}' },
  };

  const SECRET_KEY_RE = /(secret|password|passphrase|privatekey|token|secretbytes|secretkey|apikey|accesskey)/i;

  // ---------- helpers ----------

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function getIn(obj, path) {
    let cur = obj;
    for (const k of path) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[k];
    }
    return cur;
  }

  function findPair(map, key) {
    if (!YAML.isMap(map)) return null;
    return map.items.find((p) => {
      const k = YAML.isScalar(p.key) ? p.key.value : p.key;
      return String(k) === key;
    }) || null;
  }

  // Last two mapping keys above a scalar, e.g. "usernamePassword/username".
  function ctxKeys(path) {
    const keys = [];
    for (let i = path.length - 1; i >= 0 && keys.length < 2; i--) {
      if (YAML.isPair(path[i])) {
        const k = path[i].key;
        keys.push(String(YAML.isScalar(k) ? k.value : k));
      }
    }
    return { one: keys[0] || '', two: (keys[1] || '') + '/' + (keys[0] || '') };
  }

  function nodeAt(doc, path) {
    let node = doc.contents;
    for (const k of path) {
      const pair = findPair(node, k);
      if (!pair) return null;
      node = pair.value;
    }
    return node;
  }

  function collectStyles(node, styles) {
    if (!node) return;
    YAML.visit(node, {
      Scalar(key, n, path) {
        if (key === 'key' || typeof n.value !== 'string' || !n.type) return;
        const ctx = ctxKeys(path);
        for (const k of [ctx.two + '\u0000' + n.value, ctx.one + '\u0000' + n.value, '\u0000' + n.value]) {
          if (!(k in styles)) styles[k] = n.type;
        }
      },
    });
  }

  function applyStyles(node, styles) {
    YAML.visit(node, {
      Scalar(key, n, path) {
        if (key === 'key' || typeof n.value !== 'string') return;
        const ctx = ctxKeys(path);
        const t = styles[ctx.two + '\u0000' + n.value]
          || styles[ctx.one + '\u0000' + n.value]
          || styles['\u0000' + n.value];
        if (t) n.type = t;
        else if (/^\$\{[^}]*\}$/.test(n.value)) n.type = 'PLAIN';
        else n.type = 'QUOTE_DOUBLE';
      },
    });
  }

  function detectEol(text) {
    return /\r\n/.test(text) ? '\r\n' : '\n';
  }

  // ---------- parsing ----------

  function parseDoc(text) {
    const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: false });
    if (doc.errors && doc.errors.length) {
      const e = doc.errors[0];
      throw new Error('YAML error: ' + e.message);
    }
    return doc;
  }

  function parseJcasc(text) {
    const doc = parseDoc(text);
    const js = doc.toJS({ maxAliasCount: -1 }) || {};
    const styles = {};

    const viewsNode = nodeAt(doc, PATHS.views);
    const credsNode = nodeAt(doc, PATHS.creds);
    collectStyles(viewsNode, styles);
    collectStyles(credsNode, styles);

    const rawViews = getIn(js, PATHS.views);
    const views = Array.isArray(rawViews)
      ? rawViews.map((v, i) => {
        const space = !!(YAML.isSeq(viewsNode) && viewsNode.items[i] && viewsNode.items[i].spaceBefore);
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1) {
          const type = Object.keys(v)[0];
          const cfg = v[type] && typeof v[type] === 'object' ? v[type] : {};
          return { type, cfg, space };
        }
        return { type: '__raw', cfg: { raw: v }, space };
      })
      : [];

    const rawDomains = getIn(js, PATHS.creds);
    const domains = Array.isArray(rawDomains)
      ? rawDomains.map((d, di) => {
        const dNode = YAML.isSeq(credsNode) ? credsNode.items[di] : null;
        const cNode = dNode ? nodeAt({ contents: dNode }, ['credentials']) : null;
        const extra = {};
        for (const k of Object.keys(d || {})) if (k !== 'credentials') extra[k] = d[k];
        const credentials = Array.isArray(d && d.credentials)
          ? d.credentials.map((c, ci) => {
            const space = !!(YAML.isSeq(cNode) && cNode.items[ci] && cNode.items[ci].spaceBefore);
            if (c && typeof c === 'object' && Object.keys(c).length === 1) {
              const type = Object.keys(c)[0];
              return { type, cfg: c[type] && typeof c[type] === 'object' ? c[type] : {}, space };
            }
            return { type: '__raw', cfg: { raw: c }, space };
          })
          : [];
        return { extra, credentials };
      })
      : [];

    const authNode = nodeAt(doc, PATHS.auth);
    collectStyles(authNode, styles);
    const auth = parseAuth(getIn(js, PATHS.auth), authNode);

    return {
      model: {
        views,
        viewsTabBar: getIn(js, PATHS.tabBar),
        domains,
        auth,
      },
      styles,
      present: {
        views: !!viewsNode,
        tabBar: getIn(js, PATHS.tabBar) !== undefined,
        creds: !!credsNode,
        auth: !!authNode,
      },
    };
  }

  function emptyAuth(kind, raw) {
    return { kind, raw, keyOrder: ['roles'], extra: {}, types: [], rolesExtra: {}, roles: { global: [], items: [], agents: [] } };
  }

  function parseAuth(value, node) {
    if (value === undefined || value === null) return emptyAuth('none');
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !value.roleBased
      || typeof value.roleBased !== 'object') {
      return emptyAuth('other', value);
    }
    const rb = value.roleBased;
    const auth = emptyAuth('roleBased');
    auth.keyOrder = Object.keys(rb);
    if (!auth.keyOrder.includes('roles')) auth.keyOrder.push('roles');
    for (const k of Object.keys(rb)) if (k !== 'roles') auth.extra[k] = rb[k];
    const roles = rb.roles && typeof rb.roles === 'object' ? rb.roles : {};
    const rolesNode = node ? nodeAt({ contents: node }, ['roleBased', 'roles']) : null;
    for (const t of Object.keys(roles)) {
      if (!Array.isArray(roles[t])) { auth.rolesExtra[t] = roles[t]; continue; }
      auth.types.push(t);
      const seq = rolesNode ? nodeAt({ contents: rolesNode }, [t]) : null;
      auth.roles[t] = roles[t].map((r, i) => ({
        cfg: r && typeof r === 'object' && !Array.isArray(r) ? r : { name: String(r) },
        space: !!(YAML.isSeq(seq) && seq.items[i] && seq.items[i].spaceBefore),
      }));
    }
    return auth;
  }

  function authToValue(auth) {
    if (!auth || auth.kind === 'none') return undefined;
    if (auth.kind === 'other') return auth.raw;
    const types = auth.types.slice();
    for (const t of Object.keys(auth.roles)) if (!types.includes(t) && auth.roles[t].length) types.push(t);
    const roles = {};
    for (const t of types) roles[t] = (auth.roles[t] || []).map((r) => r.cfg);
    for (const k of Object.keys(auth.rolesExtra || {})) roles[k] = auth.rolesExtra[k];
    const rb = {};
    for (const k of auth.keyOrder) {
      if (k === 'roles') rb.roles = roles;
      else if (k in auth.extra) rb[k] = auth.extra[k];
    }
    for (const k of Object.keys(auth.extra)) if (!(k in rb)) rb[k] = auth.extra[k];
    return { roleBased: rb };
  }

  function roleSpacer(auth) {
    return (node) => {
      if (!auth || auth.kind !== 'roleBased' || !YAML.isMap(node)) return;
      const rb = node.get('roleBased', true);
      const roles = YAML.isMap(rb) ? rb.get('roles', true) : null;
      if (!YAML.isMap(roles)) return;
      for (const t of Object.keys(auth.roles)) {
        const seq = roles.get(t, true);
        if (!YAML.isSeq(seq)) continue;
        seq.items.forEach((it, i) => { if (i > 0 && auth.roles[t][i] && auth.roles[t][i].space) it.spaceBefore = true; });
      }
    };
  }

  // ---------- roles: members & access ----------

  const LEGACY_PREFIX_RE = /^(USER|GROUP):(.*)$/;

  /** Members of a role as [{kind, sid}]. Supports `entries: [{user: x}]` and legacy `assignments: [x]`. */
  function roleMembers(cfg) {
    if (Array.isArray(cfg.entries)) {
      return cfg.entries.map((e) => {
        if (e && typeof e === 'object') {
          const kind = PRINCIPAL_KINDS.find((k) => k in e) || Object.keys(e)[0];
          return { kind, sid: String(e[kind]) };
        }
        return { kind: 'ambiguous', sid: String(e) };
      });
    }
    if (Array.isArray(cfg.assignments)) {
      return cfg.assignments.map((a) => {
        const m = String(a).match(LEGACY_PREFIX_RE);
        return m ? { kind: m[1].toLowerCase(), sid: m[2] } : { kind: 'ambiguous', sid: String(a) };
      });
    }
    return [];
  }

  const principalKey = (p) => p.kind + ':' + p.sid;

  function parsePrincipalKey(key) {
    const i = key.indexOf(':');
    return { kind: key.slice(0, i), sid: key.slice(i + 1) };
  }

  /** Insert `key` keeping alphabetical key order when the object already is sorted (Jenkins export style). */
  function withKey(obj, key, value) {
    const keys = Object.keys(obj);
    const sorted = keys.every((k, i) => i === 0 || keys[i - 1] <= k);
    if (!sorted) return Object.assign(obj, { [key]: value });
    const out = {};
    let placed = false;
    for (const k of keys) {
      if (!placed && k > key) { out[key] = value; placed = true; }
      out[k] = obj[k];
    }
    if (!placed) out[key] = value;
    return out;
  }

  /** Add or remove a principal from a role (mutates role.cfg, may replace it). */
  function setRoleMember(role, principal, on) {
    const legacy = !Array.isArray(role.cfg.entries) && Array.isArray(role.cfg.assignments);
    const same = (m) => m.kind === principal.kind && m.sid === principal.sid;
    const has = roleMembers(role.cfg).some(same);
    if (on === has) return;
    if (legacy) {
      if (on) role.cfg.assignments.push(principal.kind === 'ambiguous' ? principal.sid : principal.kind.toUpperCase() + ':' + principal.sid);
      else role.cfg.assignments = role.cfg.assignments.filter((a, i) => !same(roleMembers({ assignments: [a] })[0]));
      return;
    }
    if (on) {
      const entry = { [principal.kind]: principal.sid };
      if (Array.isArray(role.cfg.entries)) role.cfg.entries.push(entry);
      else role.cfg = withKey(role.cfg, 'entries', [entry]);
    } else {
      role.cfg.entries = role.cfg.entries.filter((e) => !same(roleMembers({ entries: [e] })[0]));
      if (!role.cfg.entries.length) delete role.cfg.entries;
    }
  }

  /** All principals in role order of first appearance, with their role memberships. */
  function listPrincipals(auth) {
    const map = new Map();
    if (!auth || auth.kind !== 'roleBased') return [];
    for (const t of Object.keys(auth.roles)) {
      auth.roles[t].forEach((r, i) => {
        for (const m of roleMembers(r.cfg)) {
          const key = principalKey(m);
          if (!map.has(key)) map.set(key, { key, kind: m.kind, sid: m.sid, roles: [] });
          map.get(key).roles.push([t, i]);
        }
      });
    }
    return Array.from(map.values());
  }

  function isMember(role, key) {
    return roleMembers(role.cfg).some((m) => principalKey(m) === key);
  }

  /** Jobs an items role pattern matches (whole-name, Java regex semantics). */
  function roleMatches(role, jobNames) {
    const { re, error } = compileJavaRegex(role.cfg.pattern == null ? '.*' : role.cfg.pattern);
    if (error) return { jobs: [], error };
    return { jobs: re ? jobNames.filter((n) => re.test(n)) : [], error: null };
  }

  /** Effective permissions of a principal: global set + per-job set from items roles. */
  function principalAccess(auth, key, jobNames) {
    const out = { global: new Set(), globalRoles: [], itemRoles: [], agentRoles: [], jobs: new Map(), admin: false };
    if (!auth || auth.kind !== 'roleBased') return out;
    for (const t of Object.keys(auth.roles)) {
      auth.roles[t].forEach((r, i) => {
        if (!isMember(r, key)) return;
        const perms = Array.isArray(r.cfg.permissions) ? r.cfg.permissions.map(String) : [];
        if (t === 'global') {
          out.globalRoles.push(i);
          perms.forEach((p) => out.global.add(p));
        } else if (t === 'items') {
          const m = roleMatches(r, jobNames);
          out.itemRoles.push({ index: i, jobs: m.jobs });
          for (const j of m.jobs) {
            if (!out.jobs.has(j)) out.jobs.set(j, new Set());
            perms.forEach((p) => out.jobs.get(j).add(p));
          }
        } else {
          out.agentRoles.push({ type: t, index: i });
        }
      });
    }
    out.admin = out.global.has('Overall/Administer');
    // Global job/run/credential permissions apply to every item.
    const inherited = Array.from(out.global).filter((p) => /^(Job|Run|Credentials|SCM)\//.test(p));
    if (inherited.length) {
      for (const j of jobNames) {
        if (!out.jobs.has(j)) out.jobs.set(j, new Set());
        inherited.forEach((p) => out.jobs.get(j).add(p));
      }
    }
    return out;
  }

  // ---------- model -> yaml values ----------

  function viewsToValue(views) {
    return views.map((v) => (v.type === '__raw' ? v.cfg.raw : { [v.type]: v.cfg }));
  }

  function domainsToValue(domains) {
    return domains.map((d) => {
      const out = {};
      const creds = d.credentials.map((c) => (c.type === '__raw' ? c.cfg.raw : { [c.type]: c.cfg }));
      // Keep "domain" before "credentials" like Jenkins exports do.
      for (const k of Object.keys(d.extra || {})) out[k] = d.extra[k];
      out.credentials = creds;
      return out;
    });
  }

  function buildBlock(key, value, indent, styles, spacer) {
    const tmp = new YAML.Document();
    const node = tmp.createNode({ [key]: value });
    applyStyles(node, styles);
    if (spacer) spacer(node.items[0].value);
    tmp.contents = node;
    const str = tmp.toString({ indent: 2, indentSeq: true, lineWidth: 0, minContentWidth: 0 });
    const pad = ' '.repeat(indent);
    return str
      .split('\n')
      .map((l) => (l.length ? pad + l : l))
      .join('\n')
      .replace(/\n+$/, '') + '\n';
  }

  function viewSpacer(views) {
    return (seq) => {
      if (!YAML.isSeq(seq)) return;
      seq.items.forEach((it, i) => {
        if (views[i] && views[i].space && i > 0) it.spaceBefore = true;
      });
    };
  }

  function credSpacer(domains) {
    return (seq) => {
      if (!YAML.isSeq(seq)) return;
      seq.items.forEach((dn, di) => {
        const cseq = YAML.isMap(dn) ? dn.get('credentials', true) : null;
        if (!YAML.isSeq(cseq)) return;
        cseq.items.forEach((cn, ci) => {
          const c = domains[di] && domains[di].credentials[ci];
          if (c && c.space && ci > 0) cn.spaceBefore = true;
        });
      });
    };
  }

  function lineStartOf(text, offset) {
    return text.lastIndexOf('\n', offset - 1) + 1;
  }

  function lineEndAfter(text, offset) {
    if (offset > 0 && text[offset - 1] === '\n') return offset;
    const nl = text.indexOf('\n', offset);
    return nl === -1 ? text.length : nl + 1;
  }

  // Plan a splice that replaces (or inserts) `path` with `value`, leaving the rest of the text untouched.
  function planSplice(doc, text, path, value, styles, spacer) {
    let parent = doc.contents;
    let parentIndent = -2;
    let i = 0;
    for (; i < path.length; i++) {
      const pair = findPair(parent, path[i]);
      if (!pair) break;
      const keyStart = pair.key.range[0];
      const indent = keyStart - lineStartOf(text, keyStart);
      if (i === path.length - 1) {
        const start = lineStartOf(text, keyStart);
        const valEnd = pair.value && pair.value.range ? pair.value.range[1] : pair.key.range[1];
        let end = lineEndAfter(text, valEnd);
        return { start, end, text: buildBlock(path[i], value, indent, styles, spacer) };
      }
      if (!YAML.isMap(pair.value) || pair.value.flow) {
        // Replace a scalar/flow/null intermediate value with a block map holding the rest of the path.
        const start = lineStartOf(text, keyStart);
        const valEnd = pair.value && pair.value.range ? pair.value.range[1] : pair.key.range[1];
        const end = lineEndAfter(text, valEnd);
        const nested = nestValue(path.slice(i + 1), value, spacer);
        return { start, end, text: buildBlock(path[i], nested.value, indent, styles, nested.spacer) };
      }
      parent = pair.value;
      parentIndent = indent;
    }
    // Insert remaining path at the end of `parent`.
    const rest = path.slice(i);
    const nested = nestValue(rest.slice(1), value, spacer);
    let indent;
    let at;
    if (!parent || !YAML.isMap(parent)) {
      indent = 0;
      at = text.length;
    } else {
      const first = parent.items[0];
      indent = first ? first.key.range[0] - lineStartOf(text, first.key.range[0]) : parentIndent + 2;
      at = lineEndAfter(text, parent.range[1]);
      // Do not swallow trailing blank lines into the parent block.
      while (at > 1 && text[at - 1] === '\n' && text[at - 2] === '\n') at--;
    }
    let block = buildBlock(rest[0], nested.value, indent, styles, nested.spacer);
    if (at > 0 && text[at - 1] !== '\n') block = '\n' + block;
    return { start: at, end: at, text: block };
  }

  function nestValue(rest, value, spacer) {
    if (!rest.length) return { value, spacer };
    let v = value;
    for (let j = rest.length - 1; j >= 0; j--) v = { [rest[j]]: v };
    const inner = spacer
      ? (node) => {
        let n = node;
        for (const k of rest) n = YAML.isMap(n) ? n.get(k, true) : null;
        if (n) spacer(n);
      }
      : null;
    return { value: v, spacer: inner };
  }

  /**
   * Produce the full JCasC text with the edited sections spliced in.
   * Only sections flagged in `dirty` are rewritten; everything else is byte-identical.
   */
  function generate(sourceText, model, styles, dirty) {
    if (!dirty.views && !dirty.tabBar && !dirty.creds && !dirty.auth) return sourceText;
    const eol = detectEol(sourceText);
    const text = eol === '\r\n' ? sourceText.replace(/\r\n/g, '\n') : sourceText;
    let working = text;

    // Apply one splice at a time and re-parse, so insertions into the same parent stay consistent.
    const apply = (path, value, spacer) => {
      const p = planSplice(parseDoc(working), working, path, value, styles, spacer);
      working = working.slice(0, p.start) + p.text + working.slice(p.end);
    };

    if (dirty.creds) apply(PATHS.creds, domainsToValue(model.domains), credSpacer(model.domains));
    if (dirty.tabBar && model.viewsTabBar !== undefined && model.viewsTabBar !== '') {
      apply(PATHS.tabBar, model.viewsTabBar, null);
    }
    if (dirty.views) apply(PATHS.views, viewsToValue(model.views), viewSpacer(model.views));
    if (dirty.auth && model.auth && model.auth.kind !== 'none') {
      apply(PATHS.auth, authToValue(model.auth), roleSpacer(model.auth));
    }

    return eol === '\r\n' ? working.replace(/\n/g, '\r\n') : working;
  }

  function sectionText(model, styles, which) {
    if (which === 'views') {
      return buildBlock('views', viewsToValue(model.views), 0, styles, viewSpacer(model.views));
    }
    if (which === 'auth') {
      const v = authToValue(model.auth);
      return v === undefined ? '# no authorizationStrategy\n' : buildBlock('authorizationStrategy', v, 0, styles, roleSpacer(model.auth));
    }
    return buildBlock('domainCredentials', domainsToValue(model.domains), 0, styles, credSpacer(model.domains));
  }

  // ---------- jobs & references ----------

  const JOB_DECL_RE = /\b(pipelineJob|freeStyleJob|job|multibranchPipelineJob|matrixJob|mavenJob|workflowJob|buildFlowJob|folder|organizationFolder)\s*\(\s*(['"])((?:(?!\2)[^\n])+)\2/g;
  const GROOVY_REF_RE = /\b(credentialsId|credentials|credentialId|vaultCredentialId|apiTokenId|sshCredentialsId|tokenCredentialId)\b\s*(?:[:=]|\()\s*\(?\s*(['"])((?:(?!\2)[^\n])+)\2/g;
  const YAML_REF_RE = /^[ \t-]*(credentialsId|vaultCredentialId|apiTokenId|credentialId|tokenCredentialId|sshCredentialsId)[ \t]*:[ \t]*(["']?)([^"'\n#]+?)\2[ \t]*(?:#.*)?$/gm;

  function stripGroovyComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:'"])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
  }

  function lineOf(text, idx) {
    let n = 1;
    for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  }

  /** files: [{ path, text }] -> { jobs: [{name,type,path,dynamic}], refs: [{id,path,line,kind}] } */
  function scanJobFiles(files) {
    const jobs = [];
    const refs = [];
    const seen = new Set();
    for (const f of files) {
      const clean = stripGroovyComments(f.text);
      let m;
      JOB_DECL_RE.lastIndex = 0;
      while ((m = JOB_DECL_RE.exec(clean))) {
        const name = m[3].trim();
        const key = name + '\u0000' + f.path;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({
          name,
          type: m[1],
          path: f.path,
          line: lineOf(clean, m.index),
          dynamic: /\$\{?[A-Za-z_]/.test(name) && m[2] === '"',
        });
      }
      GROOVY_REF_RE.lastIndex = 0;
      while ((m = GROOVY_REF_RE.exec(clean))) {
        const id = m[3].trim();
        if (/\$\{?[A-Za-z_]/.test(id) && m[2] === '"') continue;
        refs.push({ id, path: f.path, line: lineOf(clean, m.index), kind: m[1] });
      }
    }
    jobs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { jobs, refs };
  }

  function scanJcascRefs(text, fileName) {
    const refs = [];
    const seen = new Set();
    const push = (m) => {
      const r = { id: m[3].trim(), path: fileName || 'jcasc.yml', line: lineOf(text, m.index), kind: m[1] };
      const key = r.id + '\u0000' + r.line;
      if (seen.has(key) || /^\$\{[^}]*\}$/.test(r.id)) return;
      seen.add(key);
      refs.push(r);
    };
    let m;
    YAML_REF_RE.lastIndex = 0;
    while ((m = YAML_REF_RE.exec(text))) push(m);
    // Inline Job DSL scripts embedded into the JCasC file (e.g. seed job).
    GROOVY_REF_RE.lastIndex = 0;
    while ((m = GROOVY_REF_RE.exec(text))) push(m);
    return refs;
  }

  // ---------- views ----------

  function compileJavaRegex(src) {
    if (src == null || src === '') return { re: null };
    let s = String(src);
    let flags = '';
    const inline = s.match(/^\(\?([imsux]+)\)/);
    if (inline) {
      s = s.slice(inline[0].length);
      for (const f of inline[1]) if ('ims'.includes(f) && !flags.includes(f)) flags += f;
    }
    try {
      return { re: new RegExp('^(?:' + s + ')$', flags) };
    } catch (e) {
      return { re: null, error: e.message };
    }
  }

  /**
   * Evaluate which jobs a view shows, mimicking Jenkins ListView:
   * jobNames are matched case-insensitively, includeRegex must match the whole name.
   */
  function evaluateView(view, jobNamesUniverse) {
    const result = { rows: [], missing: [], regexError: null, unsupported: false, notes: [] };
    if (view.type === 'all' || view.type === 'myView') {
      result.rows = jobNamesUniverse.map((name) => ({ name, byName: false, byRegex: false, all: true }));
      if (view.type === 'myView') result.notes.push('myView shows jobs the current user can configure; preview shows all.');
      return result;
    }
    if (view.type !== 'list') {
      result.unsupported = true;
      return result;
    }
    const cfg = view.cfg || {};
    const names = Array.isArray(cfg.jobNames) ? cfg.jobNames.map(String) : [];
    const lower = new Map();
    for (const n of names) lower.set(n.toLowerCase(), n);
    const { re, error } = compileJavaRegex(cfg.includeRegex);
    result.regexError = error || null;
    const matchedLower = new Set();
    for (const name of jobNamesUniverse) {
      const byName = lower.has(name.toLowerCase());
      const byRegex = !!(re && re.test(name));
      if (byName) matchedLower.add(name.toLowerCase());
      if (byName || byRegex) result.rows.push({ name, byName, byRegex });
    }
    for (const n of names) if (!matchedLower.has(n.toLowerCase())) result.missing.push(n);
    if (cfg.jobFilters) result.notes.push('jobFilters are preserved but not evaluated in the preview.');
    if (cfg.statusFilter !== undefined) result.notes.push('statusFilter is not evaluated (job enabled state is unknown).');
    result.rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return result;
  }

  // ---------- lint ----------

  function credentialFields(cfg, prefix, out) {
    for (const [k, v] of Object.entries(cfg || {})) {
      const p = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) credentialFields(v, p, out);
      else out.push({ path: p, key: k, value: v });
    }
    return out;
  }

  function lint(model, ctx) {
    const issues = [];
    const add = (level, area, msg, target) => issues.push({ level, area, msg, target });
    const universe = ctx.jobNames || [];
    const jobsLoaded = !!ctx.jobsLoaded;

    // Views
    const viewNames = new Map();
    const covered = new Set();
    model.views.forEach((v, i) => {
      const name = v.cfg && v.cfg.name;
      if (!name) add('error', 'views', `View #${i + 1} has no name`, { view: i });
      else {
        const key = String(name).toLowerCase();
        if (viewNames.has(key)) add('error', 'views', `Duplicate view name "${name}"`, { view: i });
        viewNames.set(key, i);
      }
      if (v.type === '__raw') add('warn', 'views', `View #${i + 1} has an unexpected structure`, { view: i });
      if (v.type !== 'list') return;
      const ev = evaluateView(v, universe);
      if (ev.regexError) add('error', 'views', `"${name}": invalid includeRegex (${ev.regexError})`, { view: i });
      const names = Array.isArray(v.cfg.jobNames) ? v.cfg.jobNames : [];
      const dup = new Set();
      for (const n of names) {
        const k = String(n).toLowerCase();
        if (dup.has(k)) add('warn', 'views', `"${name}": duplicate jobNames entry "${n}"`, { view: i });
        dup.add(k);
        if (/[.*+?^$()[\]{}|\\]/.test(String(n)) && /\.\*|\\|\[|\(/.test(String(n))) {
          add('warn', 'views', `"${name}": jobNames entry "${n}" looks like a regex, but jobNames are literal names (use includeRegex)`, { view: i });
        }
      }
      if (jobsLoaded) {
        for (const n of ev.missing) add('warn', 'views', `"${name}": job "${n}" not found in jobs folder`, { view: i });
        if (!ev.rows.length) add('info', 'views', `"${name}": view is empty`, { view: i });
      }
      for (const r of ev.rows) covered.add(r.name);
    });
    if (jobsLoaded) {
      const orphans = universe.filter((n) => !covered.has(n));
      if (orphans.length) add('info', 'views', `${orphans.length} job(s) are not shown in any list view`, { orphans: true });
    }

    // Credentials
    const ids = new Map();
    const refs = ctx.refs || [];
    const refIds = new Set(refs.map((r) => r.id));
    model.domains.forEach((d, di) => {
      d.credentials.forEach((c, ci) => {
        const target = { cred: [di, ci] };
        const id = c.cfg && c.cfg.id;
        if (c.type === '__raw') { add('warn', 'creds', `Credential #${ci + 1} has an unexpected structure`, target); return; }
        if (!id) add('error', 'creds', `${c.type} credential #${ci + 1} has no id`, target);
        else {
          if (ids.has(id)) add('error', 'creds', `Duplicate credential id "${id}"`, target);
          ids.set(id, target);
          if (jobsLoaded && !refIds.has(id)) add('info', 'creds', `"${id}" is not referenced by any job or JCasC setting`, target);
        }
        for (const f of credentialFields(c.cfg, '', [])) {
          if (SECRET_KEY_RE.test(f.key) && typeof f.value === 'string' && f.value && !/\$\{[^}]+\}/.test(f.value)) {
            add('warn', 'creds', `"${id || c.type}": field ${f.path} contains a plain-text secret (use \${VAR})`, target);
          }
          if (typeof f.value === 'string' && /^\$\{\s*\}$|_\}$/.test(f.value) && SECRET_KEY_RE.test(f.key)) {
            add('warn', 'creds', `"${id || c.type}": field ${f.path} has an incomplete variable "${f.value}"`, target);
          }
        }
        if (c.cfg.scope && !['GLOBAL', 'SYSTEM', 'USER'].includes(c.cfg.scope)) {
          add('warn', 'creds', `"${id}": unknown scope "${c.cfg.scope}"`, target);
        }
      });
    });
    const undefinedRefs = new Map();
    for (const r of refs) if (!ids.has(r.id)) {
      if (!undefinedRefs.has(r.id)) undefinedRefs.set(r.id, []);
      undefinedRefs.get(r.id).push(r);
    }
    for (const [id, rs] of undefinedRefs) {
      add('warn', 'creds', `"${id}" is referenced (${rs[0].path}:${rs[0].line}${rs.length > 1 ? ` +${rs.length - 1}` : ''}) but not defined here`, { ref: id });
    }
    lintRoles(model.auth, universe, jobsLoaded, add);
    return issues;
  }

  function lintRoles(auth, universe, jobsLoaded, add) {
    if (!auth || auth.kind === 'none') return;
    if (auth.kind === 'other') {
      add('info', 'roles', 'authorizationStrategy is not roleBased; the roles editor is read-only', {});
      return;
    }
    for (const t of Object.keys(auth.roles)) {
      const names = new Set();
      const known = new Set(PERMISSIONS[t] || []);
      auth.roles[t].forEach((r, i) => {
        const target = { role: [t, i] };
        const name = r.cfg.name;
        const label = `${t} role "${name || '#' + (i + 1)}"`;
        if (!name) add('error', 'roles', `${t} role #${i + 1} has no name`, target);
        else if (names.has(name)) add('error', 'roles', `Duplicate ${label}`, target);
        names.add(name);
        const perms = Array.isArray(r.cfg.permissions) ? r.cfg.permissions.map(String) : [];
        if (!perms.length) add('warn', 'roles', `${label} grants no permissions`, target);
        const dupP = perms.filter((p, k) => perms.indexOf(p) !== k);
        if (dupP.length) add('warn', 'roles', `${label}: duplicate permission ${dupP[0]}`, target);
        for (const p of perms) {
          if (known.has(p)) continue;
          const elsewhere = ROLE_TYPES.some((x) => x !== t && (PERMISSIONS[x] || []).includes(p));
          add(elsewhere ? 'warn' : 'info', 'roles', elsewhere
            ? `${label}: "${p}" is not applicable to ${t} roles`
            : `${label}: unknown permission "${p}"`, target);
        }
        const members = roleMembers(r.cfg);
        if (!members.length) add('info', 'roles', `${label} has no members`, target);
        const seen = new Set();
        for (const m of members) {
          const k = principalKey(m);
          if (seen.has(k)) add('warn', 'roles', `${label}: ${m.sid} is listed twice`, target);
          seen.add(k);
          if (m.kind === 'ambiguous') add('info', 'roles', `${label}: "${m.sid}" is ambiguous (use user: or group:)`, target);
        }
        if (t === 'global' && r.cfg.pattern != null && r.cfg.pattern !== '.*') {
          add('info', 'roles', `${label}: pattern "${r.cfg.pattern}" is ignored for global roles`, target);
        }
        if (t !== 'global') {
          const { jobs, error } = roleMatches(r, universe);
          if (error) add('error', 'roles', `${label}: invalid pattern (${error})`, target);
          else if (t === 'items' && jobsLoaded && !jobs.length) add('info', 'roles', `${label}: pattern matches no jobs`, target);
        }
      });
    }
    // Without Overall/Read nothing else is reachable.
    for (const p of listPrincipals(auth)) {
      const acc = principalAccess(auth, p.key, []);
      const canRead = acc.global.has('Overall/Read') || acc.global.has('Overall/Administer');
      if (!canRead && (acc.itemRoles.length || acc.agentRoles.length)) {
        add('warn', 'roles', `${p.sid} has item/agent roles but no global role with Overall/Read — they will not see anything`, { principal: p.key });
      }
    }
  }

  // ---------- diff ----------

  /** Line diff (LCS). Returns ops: [{type:'same'|'add'|'del', a?:line, b?:line, text}] */
  function diffLines(aText, bText) {
    const a = aText.replace(/\r\n/g, '\n').split('\n');
    const b = bText.replace(/\r\n/g, '\n').split('\n');
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const A = a.slice(pre, a.length - suf);
    const B = b.slice(pre, b.length - suf);
    const n = A.length;
    const m = B.length;
    const ops = [];
    for (let i = 0; i < pre; i++) ops.push({ type: 'same', a: i, b: i, text: a[i] });
    if (n * m > 25e6) {
      A.forEach((t, i) => ops.push({ type: 'del', a: pre + i, text: t }));
      B.forEach((t, j) => ops.push({ type: 'add', b: pre + j, text: t }));
    } else {
      const dp = new Uint32Array((n + 1) * (m + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * (m + 1) + j] = A[i] === B[j]
            ? dp[(i + 1) * (m + 1) + j + 1] + 1
            : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (A[i] === B[j]) { ops.push({ type: 'same', a: pre + i, b: pre + j, text: A[i] }); i++; j++; }
        else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { ops.push({ type: 'del', a: pre + i, text: A[i] }); i++; }
        else { ops.push({ type: 'add', b: pre + j, text: B[j] }); j++; }
      }
      while (i < n) { ops.push({ type: 'del', a: pre + i, text: A[i] }); i++; }
      while (j < m) { ops.push({ type: 'add', b: pre + j, text: B[j] }); j++; }
    }
    for (let k = suf; k > 0; k--) {
      ops.push({ type: 'same', a: a.length - k, b: b.length - k, text: a[a.length - k] });
    }
    return ops;
  }

  return {
    PATHS,
    KNOWN_COLUMNS,
    VIEW_TYPES,
    CREDENTIAL_TEMPLATES,
    SECRET_KEY_RE,
    clone,
    parseJcasc,
    generate,
    sectionText,
    scanJobFiles,
    scanJcascRefs,
    evaluateView,
    compileJavaRegex,
    lint,
    diffLines,
    credentialFields,
    ROLE_TYPES,
    PRINCIPAL_KINDS,
    PERMISSIONS,
    authToValue,
    roleMembers,
    principalKey,
    parsePrincipalKey,
    setRoleMember,
    listPrincipals,
    isMember,
    roleMatches,
    principalAccess,
  };
});
