/* 对话导出脚本 v2 — Gemini / Grok / ChatGPT / Claude
 *
 * 用法：在要导出的对话页面按 F12 打开控制台，整段粘贴回车。
 * 它会一边向上滚动一边采集，直到再也捞不到新内容，
 * 最后下载两个文件：一份 Markdown（给人看）、一份 JSON（给程序导入）。
 *
 * v2 相比 v1 的关键改动：不再「先滚完再抓」，而是「滚一段抓一段、累积去重」，
 * 因为这些站会回收滚出视口的 DOM 节点，等滚完再抓早期内容已经没了。
 *
 * 说明：全程只做 DOM 文本搬运，不解析、不判断、不上传任何内容。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- 找出所有可能的滚动容器 ---------- */
  // 放宽：不再要求 overflowY 是 auto/scroll —— Angular CDK 那类容器常常不是，
  // 但仍然可以用代码设 scrollTop。宁可多找几个，设了也无害。
  function findScrollers() {
    const set = new Set();
    const KNOWN_BOX = [
      'infinite-scroller',                 // Gemini
      'cdk-virtual-scroll-viewport',       // Angular CDK 虚拟滚动
      '[class*="chat-history"]',
      '[class*="conversation-container"]',
      '[class*="scroll"]',
      'main', '[role="main"]', '[role="log"]'
    ].join(', ');
    try {
      document.querySelectorAll(KNOWN_BOX).forEach((el) => set.add(el));
    } catch (e) {}
    document.querySelectorAll('*').forEach((el) => {
      if (el.clientHeight < 200) return;                    // 只要视口级的大容器
      if (el.scrollHeight > el.clientHeight + 40) set.add(el);
    });
    if (document.scrollingElement) set.add(document.scrollingElement);
    if (document.body) set.add(document.body);
    return [...set];
  }

  function describeScrollers(list) {
    return list.slice(0, 14).map((el) => {
      const cls = typeof el.className === 'string'
        ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return el.tagName.toLowerCase() + (cls ? '.' + cls : '') +
        ' [可见' + el.clientHeight + '/内容' + el.scrollHeight + ']';
    });
  }

  /* ---------- 定位对话节点：先试已知结构，再用启发式 ---------- */
  const KNOWN = [
    'user-query, model-response',                 // Gemini 的 Angular 自定义元素
    '[data-message-author-role]',                 // ChatGPT 系
    '[data-testid^="conversation-turn"]',
    '[data-testid*="message" i]',
    'article[data-testid]',
  ];

  function pickNodes() {
    for (const sel of KNOWN) {
      let nodes;
      try {
        nodes = [...document.querySelectorAll(sel)];
      } catch (e) {
        continue;
      }
      nodes = nodes.filter((n) => (n.innerText || '').trim().length > 0);
      if (nodes.length >= 2) return { nodes, how: '已知结构 ' + sel, sure: true };
    }
    // 启发式：某容器下有 >=2 个含长文本的直接子元素
    let best = null;
    let bestScore = 0;
    document.querySelectorAll('*').forEach((box) => {
      const kids = [...box.children].filter((k) => (k.innerText || '').trim().length >= 30);
      if (kids.length < 2) return;
      const total = kids.reduce((s, k) => s + k.innerText.trim().length, 0);
      const score = kids.length * Math.min(total / kids.length, 4000);
      if (score > bestScore) {
        bestScore = score;
        best = { nodes: kids, how: '启发式 <' + box.tagName.toLowerCase() + '>', sure: false };
      }
    });
    return best || { nodes: [], how: '未识别', sure: false };
  }

  /* ---------- 判断这一轮是谁说的 ---------- */
  function roleOf(el, index) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'user-query') return 'user';
    if (tag === 'model-response') return 'assistant';

    const attr = el.dataset.messageAuthorRole || el.getAttribute('data-role') || '';
    if (/user|human/i.test(attr)) return 'user';
    if (/assistant|model|bot|ai/i.test(attr)) return 'assistant';

    const inner = el.querySelector('[data-message-author-role]');
    if (inner) {
      const a = inner.dataset.messageAuthorRole || '';
      if (/user|human/i.test(a)) return 'user';
      if (/assistant|model/i.test(a)) return 'assistant';
    }
    if (el.querySelector('user-query')) return 'user';
    if (el.querySelector('model-response')) return 'assistant';

    const cls = typeof el.className === 'string' ? el.className : '';
    if (/user|query|human|sent/i.test(cls)) return 'user';
    if (/model|response|assistant|bot|received/i.test(cls)) return 'assistant';

    return index % 2 === 0 ? 'user' : 'assistant';
  }

  const clean = (s) =>
    (s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, '').trim();

  /* ---------- 边滚边采集 ---------- */
  const seen = new Map();          // 文本指纹 -> 记录
  let scrollers = findScrollers();
  let how = '';
  let sure = false;
  let batch = 0;

  function sweep() {
    const found = pickNodes();
    how = found.how;
    sure = found.sure;
    let gained = 0;
    found.nodes.forEach((el, i) => {
      const text = clean(el.innerText);
      if (!text) return;
      const key = text.slice(0, 160);          // 只用文本做指纹，角色判定可能随批次波动
      if (seen.has(key)) {
        seen.get(key).lastIdx = i;             // 刷新它当前在 DOM 里的位置
        return;
      }
      // firstIdx 记首次发现时的位置，排序要用，之后不能被覆盖
      seen.set(key, { role: roleOf(el, i), text, batch, firstIdx: i, lastIdx: i });
      gained++;
    });
    return { gained, domCount: found.nodes.length, first: found.nodes[0] };
  }

  /* ---------- 往上滚：四种手段轮换，不指望某一种一定管用 ---------- */
  const MODE_NAME = ['滚到首个节点', '各容器上移两屏', '派发 wheel 事件', '各容器归零'];
  function tryScrollUp(attempt, firstNode) {
    const mode = attempt % 4;
    if (mode === 0 && firstNode) {
      // 最有效的一招：让浏览器自己找该滚哪个容器
      try { firstNode.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    } else if (mode === 1) {
      scrollers.forEach((s) => {
        try { s.scrollTop = Math.max(0, s.scrollTop - Math.max(500, s.clientHeight * 2)); } catch (e) {}
      });
    } else if (mode === 2 && firstNode) {
      // 有些站是监听 wheel 才触发懒加载
      try {
        firstNode.dispatchEvent(new WheelEvent('wheel', { deltaY: -1500, bubbles: true, cancelable: true }));
      } catch (e) {}
    } else {
      scrollers.forEach((s) => { try { s.scrollTop = 0; } catch (e) {} });
      try { window.scrollTo(0, 0); } catch (e) {}
    }
    return mode;
  }

  console.log('页面：' + location.href);
  console.log('滚动容器候选 ' + scrollers.length + ' 个：', describeScrollers(scrollers));
  let last = sweep();
  console.log('初始采集：DOM 里 ' + last.domCount + ' 个节点，收进 ' + seen.size + ' 条（' + how + '）');
  if (!seen.size) {
    console.error('一条都没抓到。把控制台的 Elements 结构发我，我加选择器。');
    return;
  }

  let noGain = 0;
  for (let i = 0; i < 400; i++) {
    batch++;
    const mode = tryScrollUp(i, last.first);
    await sleep(650);
    // 容器可能是懒创建的，隔几轮重新找一次
    if (i % 8 === 7) scrollers = findScrollers();
    last = sweep();
    if (last.gained > 0) {
      noGain = 0;
      console.log('  第 ' + batch + ' 轮（' + MODE_NAME[mode] + '）：新增 ' + last.gained + '，累计 ' + seen.size);
    } else {
      noGain++;
      if (i < 8) console.log('  第 ' + batch + ' 轮（' + MODE_NAME[mode] + '）：没新增，DOM 里 ' + last.domCount + ' 个');
      // 四种手段各试两遍都没动静才放弃
      if (noGain >= 8) {
        console.log('  连续 8 轮没有新内容，停止（累计 ' + seen.size + ' 条）');
        break;
      }
    }
  }

  /* ---------- 排序 ---------- */
  const all = [...seen.values()];
  const allStillInDom = last.domCount >= all.length;
  if (allStillInDom) {
    // 节点没被回收，全都还在 DOM 里，直接用最新的 DOM 顺序
    all.sort((a, b) => a.lastIdx - b.lastIdx);
  } else {
    // 节点被回收过：越晚发现的越靠前（因为一直在往上滚），批次内用首次发现的位置
    all.sort((a, b) => (b.batch - a.batch) || (a.firstIdx - b.firstIdx));
  }
  console.log('排序依据：' + (allStillInDom ? 'DOM 顺序' : '发现批次倒序（节点被回收过）'));

  // 启发式识别时角色不可靠，按最终顺序重新交替标注
  if (!sure) {
    all.forEach((t, i) => { t.role = i % 2 === 0 ? 'user' : 'assistant'; });
    console.warn('未命中已知结构，角色按奇偶交替推定，导出后请自行核对。');
  }

  const turns = all.map((t, i) => ({ index: i + 1, role: t.role, text: t.text }));

  /* ---------- 组装并下载 ---------- */
  const title = (document.title || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  const md = [
    '# ' + title,
    '',
    '> 来源：' + location.href,
    '> 导出时间：' + new Date().toLocaleString('zh-CN'),
    '> 共 ' + turns.length + ' 轮｜识别方式：' + how,
    '',
    '---',
    '',
    ...turns.map(
      (t) =>
        '## [' + String(t.index).padStart(2, '0') + '] ' + (t.role === 'user' ? '我' : 'AI') + '\n\n' + t.text + '\n'
    ),
  ].join('\n');

  const json = JSON.stringify(
    {
      source: location.href,
      title,
      exportedAt: new Date().toISOString(),
      detectedBy: how,
      turnCount: turns.length,
      turns,
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

  console.log('✅ 共 ' + turns.length + ' 轮，已下载 .md 和 .json');
  console.table(
    turns.slice(0, 10).map((t) => ({
      轮次: t.index,
      角色: t.role,
      字数: t.text.length,
      开头: t.text.slice(0, 40),
    }))
  );
  console.log('对一下轮次顺序和角色对不对；数量还是不够就把上面的滚动日志发我。');
})();
