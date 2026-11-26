/* dsh-guard-native client half: a Settings section that reports the gate and performs two narrow
 * actions (emergency switches, settings file).
 *
 * Contract per the installed docs: a lazy factory whose id equals the package name, returning the
 * plugin object `{ inject, apply }`. The host serves this file as /plugins/dsh-guard-native/client.js.
 * No build step: the factory is plain browser JavaScript and React comes from the module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-guard-native',
  factory(require) {
    'use strict';
    var react = require('react');
    var h = react.createElement;

    var CSS = [
      '.gn{display:flex;flex-direction:column;gap:14px;padding:4px 2px;font-size:13px;}',
      '.gn-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
      '.gn-chip{background:rgba(140,190,245,.12);border:1px solid rgba(140,190,245,.3);border-radius:999px;padding:3px 10px;white-space:nowrap;}',
      '.gn-chip.warn{background:rgba(224,80,90,.18);border-color:rgba(224,80,90,.45);}',
      '.gn-chip.ok{background:rgba(80,200,140,.14);border-color:rgba(80,200,140,.4);}',
      '.gn-card{border:1px solid rgba(140,190,245,.25);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;}',
      '.gn-card h4{margin:0;font-size:13px;font-weight:600;}',
      '.gn-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
      '.gn-table{width:100%;border-collapse:collapse;font-size:12px;}',
      '.gn-table th{text-align:left;padding:4px 8px;border-bottom:1px solid rgba(140,190,245,.2);opacity:.75;font-weight:500;}',
      '.gn-table td{padding:4px 8px;border-bottom:1px solid rgba(140,190,245,.1);vertical-align:top;}',
      '.gn-table td.mono{font-family:Consolas,monospace;font-size:11px;word-break:break-all;}',
      '.gn-btn{border:1px solid rgba(140,190,245,.4);background:rgba(255,255,255,.08);color:inherit;border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px;}',
      '.gn-btn:hover{background:rgba(255,255,255,.16);}',
      '.gn-btn.primary{background:#3b82f6;border-color:transparent;color:#fff;}',
      '.gn-btn.danger{background:rgba(224,80,90,.75);border-color:transparent;color:#fff;}',
      '.gn-btn:disabled{opacity:.5;cursor:default;}',
      '.gn-muted{opacity:.6;font-size:12px;}',
      '.gn-err{color:#e05a64;}',
      '.gn-msg{color:#5ac48c;}',
      '.gn-link{color:#5aa9e6;cursor:pointer;text-decoration:underline;}',
    ].join('');

    function api(url, opts) {
      return fetch(url, Object.assign({ headers: { accept: 'application/json' } }, opts || {}))
        .then(function (r) { return r.json(); });
    }

    function post(payload) {
      return api('/dsh-guard/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    function Chip(props) {
      return h('span', { className: 'gn-chip' + (props.tone ? ' ' + props.tone : '') }, props.children);
    }

    function Card(props) {
      return h('div', { className: 'gn-card' },
        props.title ? h('h4', null, props.title) : null,
        props.children);
    }

    function pct(v) { return v === null || v === undefined ? '—' : Math.round(v * 100) + '%'; }

    // The ledger stores UTC ISO strings. Showing `ts.slice(11,19)` displayed a UTC clock face with no
    // hint, so a 23:37 local event looked like 15:37. Convert to the VIEWER's timezone and say so.
    function fmtTime(ts) {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts || '');
      var time = d.toLocaleTimeString([], { hour12: false });
      var sameDay = d.toDateString() === new Date().toDateString();
      return sameDay ? time : d.toLocaleDateString() + ' ' + time;
    }

    function Section() {
      var st = react.useState(null); var data = st[0], setData = st[1];
      var er = react.useState(''); var err = er[0], setErr = er[1];
      var ms = react.useState(''); var msg = ms[0], setMsg = ms[1];
      var bs = react.useState(false); var busy = bs[0], setBusy = bs[1];
      var fm = react.useState(null); var form = fm[0], setForm = fm[1];

      var refresh = function () {
        return api('/dsh-guard/status?format=json')
          .then(function (j) {
            setData(j);
            setForm(function (prev) {
              if (prev !== null) return prev;
              var e = (j && j.config && j.config.effective) || {};
              return {
                statusLine: e.statusLine === 'brief' ? 'brief' : (e.statusLine === false ? 'false' : 'true'),
                gating: e.gating !== false,
                askMode: e.askMode === 'deny' ? 'deny' : 'ask',
                statusRouteAuth: e.statusRouteAuth === 'local' ? 'local' : 'connection',
                additionalRoots: (e.additionalRoots || []).join(', '),
                extraGatedTools: (e.extraGatedTools || []).join(', '),
                rememberApproved: !!(e.rememberApproved && e.rememberApproved.enabled),
              };
            });
          })
          .catch(function (e) { setErr('无法读取状态：' + String((e && e.message) || e)); });
      };

      react.useEffect(function () {
        refresh();
        var timer = setInterval(refresh, 10000);
        return function () { clearInterval(timer); };
      }, []);

      var toggleSwitch = function (name, on) {
        if (busy) return;
        if (on && name === 'DISABLE' && !window.confirm('DISABLE 会关闭闸门，批量删除将无人拦截。继续？')) return;
        setBusy(true); setErr(''); setMsg('');
        post({ kind: 'switch', name: name, on: on })
          .then(function (j) {
            setBusy(false);
            if (j && j.ok) { setMsg(name + (on ? ' 已打开（下一次工具调用生效）' : ' 已关闭')); refresh(); }
            else setErr((j && j.error) || '操作失败');
          })
          .catch(function (e) { setBusy(false); setErr(String((e && e.message) || e)); });
      };

      var saveConfig = function () {
        if (busy || !form) return;
        setBusy(true); setErr(''); setMsg('');
        post({
          kind: 'config',
          patch: {
            statusLine: form.statusLine === 'brief' ? 'brief' : (form.statusLine === 'false' ? false : true),
            gating: form.gating,
            askMode: form.askMode === 'deny' ? 'deny' : 'ask',
            statusRouteAuth: form.statusRouteAuth === 'local' ? 'local' : 'connection',
            // Accept commas, semicolons or one entry per line: paths contain backslashes but never
            // those separators, so splitting on them is safe.
            additionalRoots: String(form.additionalRoots || '').split(/[\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean),
            extraGatedTools: String(form.extraGatedTools || '').split(/[\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean),
            rememberApproved: { enabled: form.rememberApproved, ttlSeconds: 900 },
          },
        })
          .then(function (j) {
            setBusy(false);
            if (j && j.ok) setMsg('已写入 ' + j.path + '（多数项需重启 dsh 生效）');
            else setErr((j && j.error) || '保存失败');
          })
          .catch(function (e) { setBusy(false); setErr(String((e && e.message) || e)); });
      };

      // The desktop shell blocks window.open(), so "open in a tab" did nothing. The absolute URL is
      // also rendered as a READ-ONLY input: clicking it selects the whole address, which works even
      // when the Clipboard API is denied (iframe/shadow DOM), and gives visible feedback at the top.
      // Prefer the ABSOLUTE url the host computed from the request Host header. In a sandboxed iframe
      // `window.location.origin` is "null", so an origin-built link was useless there.
      var statusUrl = String((data && data.surfaces && data.surfaces.thisPage)
        || (String((typeof window !== 'undefined' && window.location && window.location.origin) || '') + '/dsh-guard/status'));
      var cn = react.useState(''); var copyNote = cn[0], setCopyNote = cn[1];
      var noteTimer = null;
      var note = function (text) {
        setCopyNote(text);
        if (noteTimer) clearTimeout(noteTimer);
        noteTimer = setTimeout(function () { setCopyNote(''); }, 3000);
      };
      var copyStatusUrl = function () {
        var fallback = function () {
          try {
            var ta = document.createElement('textarea');
            ta.value = statusUrl;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            ta.remove();
            note(ok ? '已复制 ✓' : '请点地址框后按 Ctrl+C');
          } catch (e2) { note('请点地址框后按 Ctrl+C'); }
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(statusUrl).then(function () { note('已复制 ✓'); }, fallback);
            return;
          }
        } catch (e) { /* fall through */ }
        fallback();
      };

      if (!data) {
        return h('div', { className: 'gn' },
          h('div', { className: 'gn-muted' }, '正在读取 dsh-guard 状态…'),
          err ? h('div', { className: 'gn-err' }, err) : null);
      }

      var p = data.plugin || {};
      var posture = data.posture || {};
      var ws = data.workspace || {};
      var ap = data.approvals || {};
      var all = ap.allTime || {};
      var audit = data.audit || {};
      var switchNames = (posture.switches || []).filter(function (s) { return s !== 'none'; });
      var sessions = data.sessions || [];

      var switchRow = function (name, hint) {
        var on = switchNames.indexOf(name) !== -1;
        return h('div', { className: 'gn-row', key: name },
          h('span', { style: { minWidth: '9.5em' } }, name, h('span', { className: 'gn-muted' }, ' ' + hint)),
          h('button', {
            className: 'gn-btn' + (on ? ' danger' : ''),
            disabled: busy,
            onClick: function () { toggleSwitch(name, !on); },
          }, on ? '已开启 — 点此关闭' : '开启'));
      };

      return h('div', { className: 'gn' },
        h('div', { className: 'gn-head' },
          h('strong', null, 'dsh-guard ' + p.id),
          h(Chip, { tone: String(posture.headline || '').indexOf('DISABLED') === 0 ? 'warn' : 'ok' }, posture.headline || ''),
          h(Chip, null, '加载于 ' + String(p.loadedAt || '').slice(0, 19)),
          h(Chip, null, '进程 ' + p.pid),
          h('a', { className: 'gn-link', href: statusUrl, target: '_blank', rel: 'noopener noreferrer' }, '打开'),
          h('input', {
            type: 'text',
            readOnly: true,
            value: statusUrl,
            title: '点击选中整条地址，然后按 Ctrl+C',
            onFocus: function (ev) { ev.target.select(); },
            onClick: function (ev) { ev.target.select(); },
            style: { width: '25em', font: 'inherit', fontSize: '11px', padding: '2px 4px' },
          }),
          h('button', { className: 'gn-btn', type: 'button', onClick: copyStatusUrl }, '复制'),
          h('span', { className: 'gn-muted' }, copyNote)),

        h(Card, { title: '工作区与目录' },
          h('div', { className: 'gn-muted' }, 'workspace 回退值：' + (ws.configuredFallback || '（未设置：每个会话用自己的 cwd）')),
          sessions.length
            ? h('table', { className: 'gn-table' },
              h('thead', null, h('tr', null, h('th', null, '会话'), h('th', null, '工作区'), h('th', null, '当前目录'))),
              h('tbody', null, sessions.map(function (s) {
                return h('tr', { key: s.id },
                  h('td', { className: 'mono' }, s.id),
                  h('td', { className: 'mono' }, s.workspace),
                  h('td', { className: 'mono' }, s.cwd || ''));
              })))
            : h('div', { className: 'gn-muted' }, '本进程尚未判定任何会话的调用。')),

        h(Card, { title: '审批结果（最近 ' + (ap.hours || 24) + ' 小时，时间为本地时间）' },
          h('div', { className: 'gn-row' },
            h(Chip, null, '闸门询问 ' + ((audit.window && audit.window.ask) || 0)),
            h(Chip, null, '询问 ' + (ap.asked || 0)),
            h(Chip, { tone: 'ok' }, '已批准 ' + (ap.approved || 0)),
            h(Chip, { tone: ap.rejected ? 'warn' : undefined }, '已拒绝 ' + (ap.rejected || 0)),
            h(Chip, null, '待定 ' + (ap.pending || 0)),
            h(Chip, null, '批准率 ' + pct(ap.approvalRate))),
          (ap.autoRejected || 0) > 0
            ? h('div', { className: 'gn-muted' }, '其中 ' + ap.autoRejected + ' 次在 50ms 内被拒绝：没有可用应答者，按 fail-closed 自动拒绝（等于静默拦截，不是人拒的）。')
            : null,
          (!ap.asked && audit.window && audit.window.ask > 0)
            ? h('div', { className: 'gn-muted' }, '闸门在窗口内 ask 了 ' + audit.window.ask + ' 次，但没有任何一次到达应答者；这些调用没有执行。')
            : null,
          (ap.byRuleRejected || []).length
            ? h('table', { className: 'gn-table' },
              h('thead', null, h('tr', null, h('th', null, '被拒规则'), h('th', null, '次数'))),
              h('tbody', null, ap.byRuleRejected.map(function (r) {
                return h('tr', { key: r.rule }, h('td', { className: 'mono' }, r.rule), h('td', null, String(r.count)));
              })))
            : h('div', { className: 'gn-muted' }, '这个窗口内没有弹窗被拒——要么没触发，要么判定准确。'),
          h('div', { className: 'gn-muted' }, '累计：' + (all.asked || 0) + ' 次询问 · ' + (all.approved || 0) + ' 已批准 · ' + (all.rejected || 0) + ' 已拒绝' + (all.since ? '（自 ' + fmtTime(all.since) + '）' : ''))),

        h(Card, { title: '审计台账（时间为本地时间）' },
          h('div', { className: 'gn-row' },
            h(Chip, null, (audit.total || 0) + ' 行'),
            h(Chip, null, '最近200 放行/询问/拦截：' + ((audit.last200 && audit.last200.allow) || 0) + ' / ' + ((audit.last200 && audit.last200.ask) || 0) + ' / ' + ((audit.last200 && audit.last200.deny) || 0)),
            h(Chip, null, '轮转 ' + (audit.rotation || ''))),
          h('div', { className: 'gn-muted mono' }, audit.file || ''),
          (audit.recent || []).length
            ? h('table', { className: 'gn-table' },
              h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '判定'), h('th', null, '规则'), h('th', null, '目标'))),
              h('tbody', null, audit.recent.slice(0, 8).map(function (r, i) {
                return h('tr', { key: i },
                  h('td', { className: 'mono' }, fmtTime(r.ts)),
                  h('td', null, r.decision),
                  h('td', { className: 'mono' }, (r.rules || []).join(', ')),
                  h('td', { className: 'mono' }, r.preview || ''));
              })))
            : h('div', { className: 'gn-muted' }, '台账暂无记录。')),

        h(Card, { title: '紧急开关（立即生效，无需重启）' },
          switchRow('DISABLE', '— 关闭闸门，全部放行'),
          switchRow('PANIC', '— 硬拦截降级为询问'),
          switchRow('HARD-STOP', '— 询问升级为拦截')),

        h(Card, { title: '设置（写入 dsh-guard.json，需重启 dsh）' },
          h('div', { className: 'gn-row' },
            h('span', null, '状态行'),
            h('select', {
              value: form ? form.statusLine : 'true',
              onChange: function (ev) { setForm(Object.assign({}, form, { statusLine: ev.target.value })); },
            },
            h('option', { value: 'true' }, 'full（含审计计数）'),
            h('option', { value: 'brief' }, 'brief（短，省 token）'),
            h('option', { value: 'false' }, 'off（不注入）')),
            h('span', null, '升级动作'),
            h('select', {
              value: form ? form.askMode : 'ask',
              onChange: function (ev) { setForm(Object.assign({}, form, { askMode: ev.target.value })); },
            },
            h('option', { value: 'ask' }, 'ask（弹窗问人）'),
            h('option', { value: 'deny' }, 'deny（无应答者时直接拒绝）')),
            h('span', null, '额外可信根'),
            h('textarea', {
              rows: 2,
              cols: 46,
              placeholder: 'D:\\work\\project-a\nD:\\work\\project-b',
              value: form ? form.additionalRoots : '',
              onChange: function (ev) { setForm(Object.assign({}, form, { additionalRoots: ev.target.value })); },
            }),
            h('span', null, '状态页访问'),
            h('select', {
              value: form ? form.statusRouteAuth : 'connection',
              onChange: function (ev) { setForm(Object.assign({}, form, { statusRouteAuth: ev.target.value })); },
            },
            h('option', { value: 'connection' }, '仅 app 连接（默认）'),
            h('option', { value: 'local' }, '本地浏览器可读（只读页）')),
            h('label', { className: 'gn-row' },
              h('input', {
                type: 'checkbox',
                checked: !!(form && form.gating),
                onChange: function (ev) { setForm(Object.assign({}, form, { gating: ev.target.checked })); },
              }), '闸门启用（关闭=影子模式：只记录不拦）'),
            h('label', { className: 'gn-row' },
              h('input', {
                type: 'checkbox',
                checked: !!(form && form.rememberApproved),
                onChange: function (ev) { setForm(Object.assign({}, form, { rememberApproved: ev.target.checked })); },
              }), '记住已批准的区内批量命令（15 分钟）')),
          h('div', { className: 'gn-row' },
            h('button', { className: 'gn-btn primary', disabled: busy, onClick: saveConfig }, '保存到 dsh-guard.json'),
            h('button', { className: 'gn-btn', disabled: busy, onClick: function () { setMsg(''); setErr(''); refresh(); } }, '刷新'),
            h('span', { className: 'gn-muted' }, '文件：' + ((data.config && data.config.file) || '（未使用 JSON 文件）'))),
          err ? h('div', { className: 'gn-err' }, err) : null,
          msg ? h('div', { className: 'gn-msg' }, msg) : null),

        h('div', { className: 'gn-muted' },
          '规则：批量 ' + ((data.rules && data.rules.bulk) || []).length +
          ' · 硬拦 ' + ((data.rules && data.rules.deny) || []).length +
          ' · 面板数据来自会话事件 approval/asked + approval/decided（按 approval id 配对）'));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.effect(function () {
            var style = document.createElement('style');
            style.textContent = CSS;
            document.head.append(style);
            return function () { style.remove(); };
          }, 'dsh-guard-native: section css');
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'dsh-guard-native',
              order: 95,
              label: function () { return 'dsh-guard 闸门'; },
              inject: function () { return {}; },
            }, function () { return h(Section, null); });
          });
        } catch (e) {
          if (typeof console !== 'undefined' && console.error) console.error('[dsh-guard-native client]', e);
        }
      },
    };
  },
});
