/* 分享页导出 — 专治 Gemini 分享页（share.gemini.google.com）
 *
 * 用法：打开分享链接，按 F12 → Console，整段粘贴回车。
 *
 * 原理：分享页里 AI 回复没有任何可识别的标签或前缀文字，但用户消息有气泡（<user-query>）。
 * 所以不去找 AI 回复，而是给每个用户气泡前后插入隐形哨兵，
 * 取一次整体 innerText，再按哨兵切开 —— 两个用户气泡之间的内容就是 AI 回复。
 * 用 innerText 而不是逐节点抓，是为了保留段落换行和列表缩进。
 *
 * 分享页是一次性完整渲染的，不需要滚动，所以没有虚拟滚动那堆问题。
 * 全程只做 DOM 文本搬运，不解析、不判断、不上传任何内容。
 */
(() => {
  const U = '@@@WWY_USER_START@@@';
  const E = '@@@WWY_USER_END@@@';

  /* ---------- 1. 找用户气泡 ---------- */
  let users = [...document.querySelectorAll('user-query')];
  if (!users.length) {
    // 兜底：找右对齐且有背景色的短文本块（气泡的视觉特征）
    const cands = [];
    document.querySelectorAll('div,span,p').forEach((el) => {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 3000) return;
      if (el.children.length > 6) return;
      const s = getComputedStyle(el);
      const bg = s.backgroundColor;
      if (!bg || /rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(bg)) return;
      if (parseFloat(s.borderRadius) < 6) return;
      cands.push(el);
    });
    // 去掉互相嵌套的，只保留最外层
    users = cands.filter((el) => !cands.some((o) => o !== el && o.contains(el)));
    console.log('没找到 <user-query>，用气泡视觉特征兜底，命中 ' + users.length + ' 个');
  }
  if (!users.length) {
    console.error('一个用户气泡都没找到。把页面 Elements 里用户消息那块的结构发我。');
    return;
  }
  console.log('用户消息 ' + users.length + ' 条');

  /* ---------- 2. 找包含所有气泡的最小容器 ---------- */
  let root = users[0].parentElement;
  while (root && root !== document.body && !users.every((u) => root.contains(u))) {
    root = root.parentElement;
  }
  if (!root) root = document.body;
  console.log('对话容器：<' + root.tagName.toLowerCase() + '>');

  /* ---------- 3. 插入哨兵 ---------- */
  const sentinels = [];
  users.forEach((u) => {
    const a = document.createElement('div');
    a.textContent = U;
    const b = document.createElement('div');
    b.textContent = E;
    u.parentNode.insertBefore(a, u);
    if (u.nextSibling) u.parentNode.insertBefore(b, u.nextSibling);
    else u.parentNode.appendChild(b);
    sentinels.push(a, b);
  });

  /* ---------- 4. 取整体文字，然后立刻把页面恢复原样 ---------- */
  let raw = '';
  try {
    raw = root.innerText || '';
  } finally {
    sentinels.forEach((s) => s.remove());
  }
  console.log('取到文字 ' + raw.length + ' 字');

  /* ---------- 5. 按哨兵切分 ---------- */
  const NOISE = [
    /^继续此对话$/, /^导出对话$/, /^分享$/, /^复制$/, /^举报$/,
    /^基于\s.*创建/, /^发布时间[:：]/, /^https?:\/\/\S+$/,
    /^Gemini\s*$/, /^显示更多$/, /^显示较少$/,
  ];
  const clean = (s) =>
    (s || '')
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        if (!t) return true;                       // 空行保留，用来分段
        return !NOISE.some((re) => re.test(t));
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const turns = [];
  const blocks = raw.split(U);
  // 第一个用户气泡之前的内容（通常是标题区，偶尔是 AI 开场）
  const preface = clean(blocks[0]);
  if (preface.length > 80) turns.push({ role: 'assistant', text: preface });

  blocks.slice(1).forEach((blk) => {
    const i = blk.indexOf(E);
    const uText = clean(i >= 0 ? blk.slice(0, i) : blk);
    const aText = clean(i >= 0 ? blk.slice(i + E.length) : '');
    if (uText) turns.push({ role: 'user', text: uText });
    if (aText) turns.push({ role: 'assistant', text: aText });
  });

  const list = turns
    .filter((t) => t.text.length > 0)
    .map((t, i) => ({ index: i + 1, role: t.role, text: t.text }));

  if (!list.length) {
    console.error('切出来是空的。把上面的日志发我。');
    return;
  }

  /* ---------- 6. 下载 ---------- */
  const title = (document.title || 'Gemini 分享对话')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  const md = [
    '# ' + title,
    '',
    '> 来源：' + location.href,
    '> 导出时间：' + new Date().toLocaleString('zh-CN'),
    '> 共 ' + list.length + ' 轮（用户 ' + list.filter((t) => t.role === 'user').length +
      ' / AI ' + list.filter((t) => t.role === 'assistant').length + '）',
    '',
    '---',
    '',
    ...list.map(
      (t) =>
        '## [' + String(t.index).padStart(3, '0') + '] ' +
        (t.role === 'user' ? '我' : 'AI') + '\n\n' + t.text + '\n'
    ),
  ].join('\n');

  const json = JSON.stringify(
    {
      source: location.href,
      title,
      exportedAt: new Date().toISOString(),
      detectedBy: '分享页哨兵切分',
      turnCount: list.length,
      turns: list,
    },
    null,
    2
  );

  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  download(title + '_' + stamp + '.md', md, 'text/markdown;charset=utf-8');
  download(title + '_' + stamp + '.json', json, 'application/json;charset=utf-8');

  const u = list.filter((t) => t.role === 'user').length;
  console.log('✅ 共 ' + list.length + ' 轮（我 ' + u + ' / AI ' + (list.length - u) + '），已下载 .md 和 .json');
  console.table(
    list.slice(0, 8).map((t) => ({
      轮次: t.index,
      角色: t.role,
      字数: t.text.length,
      开头: t.text.slice(0, 36),
    }))
  );
  console.log('核对：角色应该一问一答交替，AI 那几条字数应该明显更多。');
})();
