require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.static('.'));
app.use(express.json());

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const CLIENTS_DB_ID = 'cab14f67-eb77-4bdb-ae06-8267188cfa76';

// --- 送信アドレス設定 ---
const SENDER_ACCOUNTS = [
  { id: 'company', label: 'HIKOBAYU（会社）', email: process.env.EMAIL_COMPANY || 'info@hikobayu.com', signature: 'HIKOBAYU' },
  { id: 'kayo', label: '澤田佳代子', email: process.env.EMAIL_KAYO || 'someco@hikobayu.com', signature: 'HIKOBAYU　澤田佳代子' },
  { id: 'kento', label: '澤田健人', email: process.env.EMAIL_KENTO || 'kento.sawada@hikobayu.com', signature: 'HIKOBAYU　澤田健人' },
];

// --- 責任者のNotionユーザーIDマッピング ---
const ASSIGNEE_MAP = {
  '健人': '11bd872b-594c-815e-b3b9-00025cfc9738',
  '佳代': '11bd872b-594c-817f-80b4-000234f55a5b',
};

// --- 添付資料の管理 ---
const ATTACHMENTS_FILE = path.join(__dirname, 'attachments.json');

function loadAttachments() {
  try {
    return JSON.parse(fs.readFileSync(ATTACHMENTS_FILE, 'utf8'));
  } catch { return []; }
}

function saveAttachments(data) {
  fs.writeFileSync(ATTACHMENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// --- 定型文テンプレートの管理 ---
const TEMPLATES_FILE = path.join(__dirname, 'templates.json');

function loadTemplates() {
  try {
    return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
  } catch { return []; }
}

function saveTemplates(data) {
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// --- メール修正履歴の管理 ---
const HISTORY_FILE = path.join(__dirname, 'email-history.json');

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch { return []; }
}

function saveHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// --- API: 送信アドレス一覧 ---
app.get('/api/senders', (req, res) => {
  res.json(SENDER_ACCOUNTS);
});

// --- API: 添付資料 CRUD ---
app.get('/api/attachments', (req, res) => {
  res.json(loadAttachments());
});

app.post('/api/attachments', (req, res) => {
  const list = loadAttachments();
  const item = { id: Date.now().toString(), ...req.body };
  list.push(item);
  saveAttachments(list);
  res.json(item);
});

app.put('/api/attachments/:id', (req, res) => {
  const list = loadAttachments();
  const idx = list.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  list[idx] = { ...list[idx], ...req.body };
  saveAttachments(list);
  res.json(list[idx]);
});

app.delete('/api/attachments/:id', (req, res) => {
  let list = loadAttachments();
  list = list.filter(a => a.id !== req.params.id);
  saveAttachments(list);
  res.json({ ok: true });
});

// --- API: 定型文テンプレート CRUD ---
app.get('/api/templates', (req, res) => {
  res.json(loadTemplates());
});

app.post('/api/templates', (req, res) => {
  const list = loadTemplates();
  const item = { id: Date.now().toString(), ...req.body };
  list.push(item);
  saveTemplates(list);
  res.json(item);
});

app.put('/api/templates/:id', (req, res) => {
  const list = loadTemplates();
  const idx = list.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  list[idx] = { ...list[idx], ...req.body };
  saveTemplates(list);
  res.json(list[idx]);
});

app.delete('/api/templates/:id', (req, res) => {
  let list = loadTemplates();
  list = list.filter(t => t.id !== req.params.id);
  saveTemplates(list);
  res.json({ ok: true });
});

// --- API: メール修正履歴 ---
app.get('/api/email-history', (req, res) => {
  res.json(loadHistory());
});

app.post('/api/email-history', (req, res) => {
  const history = loadHistory();
  history.push({ ...req.body, savedAt: new Date().toISOString() });
  // 最大50件保持
  while (history.length > 50) history.shift();
  saveHistory(history);
  res.json({ ok: true });
});

// --- Notion: 今日のフォロー案件を取得 ---
app.post('/api/notion/query', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { assignee } = req.body || {};

    const filters = [
      { property: '次回フォロー日', date: { on_or_before: today } },
      { property: 'ステータス', multi_select: { does_not_contain: '成約' } },
      { property: 'ステータス', multi_select: { does_not_contain: '保留' } },
    ];

    // 責任者フィルター（Person型）
    if (assignee && assignee !== 'all' && ASSIGNEE_MAP[assignee]) {
      filters.push({ property: '責任者', people: { contains: ASSIGNEE_MAP[assignee] } });
    }

    const response = await fetch(
      `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filter: { and: filters },
          sorts: [{ property: '次回フォロー日', direction: 'ascending' }]
        })
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Notion query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Claude API: メール文を生成 ---
app.post('/api/claude/generate', async (req, res) => {
  try {
    const { caseInfo, senderId } = req.body;

    // 送信者の署名を決定
    const sender = SENDER_ACCOUNTS.find(s => s.id === senderId) || SENDER_ACCOUNTS[1]; // デフォルト佳代

    // ステータスに応じたメール方針
    const statusGuide = {
      '見込み段階':   '初回または初期フォロー。まだ深い関係ではないので、押しつけず森の世界観で興味を持ってもらう一歩目のメール。',
      '提案済み':     '既に提案・サンプル提供済み。感想や検討状況を自然に聞くフォローアップ。次のステップ（注文・打ち合わせ）につながる内容。',
      '検討中':       '先方が検討中。背中を押しすぎず、追加情報や季節感・タイミングを絡めた柔らかいリマインド。',
      '反応待ち':     '前回メールや提案への返信がない。圧をかけず、別角度からの話題や新情報で再アプローチ。',
      '反応なし':     '長期間コンタクトなし。関係をリセットする気持ちで、シンプルに存在を伝える短いメール。',
    };

    // 業種に応じた提案ポイント
    const industryGuide = {
      'ホテル':     'アメニティ・客室備品・ウェルカムギフトとしての提案。宿泊体験の差別化。',
      'サウナ':     'ロウリュ用アロマ水・サウナ後のスキンケアとしての提案。',
      '温浴施設':   'ロウリュや湯上がりケアとしての提案。施設のブランディング向上。',
      'ショップ':   '掛け率50%での仕入れ提案。北海道・ニセコブランドの希少性訴求。',
      '法人':       'ノベルティ・ギフト・福利厚生としての提案。',
      '美容室':     'トリートメント後のホームケアアイテムとしての提案。',
    };

    const statusText = (caseInfo.status || []).join('・') || '不明';
    const statusInstruction = statusGuide[caseInfo.status?.[0]] || '関係性に合わせた自然なフォローアップメール。';
    const industryInstruction = industryGuide[caseInfo.industry] || '相手の業態に合わせた提案。';

    // 修正履歴から学習データを構築
    const history = loadHistory();
    let learningBlock = '';
    if (history.length > 0) {
      // 同じ業種・ステータスの履歴を優先、なければ直近のものを使用
      const relevant = history
        .filter(h => h.industry === caseInfo.industry || (h.status || [])[0] === (caseInfo.status || [])[0])
        .slice(-5);
      const recent = relevant.length > 0 ? relevant : history.slice(-5);

      if (recent.length > 0) {
        learningBlock = `\n\n【過去のメール修正パターン（学習データ）】
以下は過去に生成されたメールとユーザーが実際に送信した修正後の内容です。
修正の傾向を学び、同様の修正が不要になるようメールを生成してください。\n`;
        for (const h of recent) {
          learningBlock += `\n--- 修正例（${h.industry || '不明'}・${(h.status || []).join('/')}）---
生成文（件名）: ${h.originalSubject}
修正後（件名）: ${h.editedSubject}
生成文（本文抜粋）: ${(h.originalBody || '').slice(0, 200)}...
修正後（本文抜粋）: ${(h.editedBody || '').slice(0, 200)}...\n`;
        }
      }
    }

    const systemPrompt = `あなたはHIKOBAYUというアロマ・スキンケアブランドの営業担当アシスタントです。
HIKOBAYUのブランドコア：「日常に、森へ還る時間をつくる。呼吸が深まり、余白がひらく。森へと還る、小さな儀式。」
北海道ニセコのトドマツ精油を使ったスキンケア・アロマ製品を販売しています。

【メール生成ルール】
- 売り込まない。森の時間に誘う語り口
- 簡潔・温かみ・具体性のバランスを保つ
- 署名は「${sender.signature}」で固定
- 「次のアクション」に書かれた内容を最優先でメールに反映すること
- 「ミーティングメモ」がある場合はその内容を必ず盛り込む
${learningBlock}
出力形式（JSONのみ・前後のテキスト不要）：
{"subject": "件名", "body": "本文"}`;

    const userContent = `【案件名】${caseInfo.name}
【担当者】${caseInfo.contact || '担当者'}様
【業種】${caseInfo.industry || '不明'}
【現在のステータス】${statusText}
【次のアクション（最重要）】${caseInfo.nextAction || '特になし'}
【初回接触メモ】${caseInfo.memo || 'なし'}
【サンプル送付日】${caseInfo.sampleDate || 'なし'}
【ミーティングメモ（手動補足）】${caseInfo.extraContext || 'なし'}
【本日の日付】${caseInfo.today}

---
【ステータス「${statusText}」に応じた方針】
${statusInstruction}

【業種「${caseInfo.industry}」への提案ポイント】
${industryInstruction}

上記の情報を踏まえ、このタイミングにぴったりのフォローアップメールを生成してください。`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Notion: ページ更新（次回フォロー日・次のアクション・ステータス） ---
app.patch('/api/notion/update/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;
    const { nextFollowDate, nextAction, status } = req.body;

    const properties = {};

    if (nextFollowDate) {
      properties['次回フォロー日'] = {
        date: { start: nextFollowDate }
      };
    }
    if (nextAction) {
      properties['次のアクション'] = {
        rich_text: [{ text: { content: nextAction } }]
      };
    }
    if (status) {
      properties['ステータス'] = {
        multi_select: status.map(s => ({ name: s }))
      };
    }

    const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ properties })
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Notion update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- 取引先一覧取得 ---
app.post('/api/clients/query', async (req, res) => {
  try {
    const { channel, followStatus, limit } = req.body || {};
    const filters = [];

    // チャネルフィルター
    if (channel === 'freee') {
      filters.push({
        or: [
          { property: 'ソース', select: { equals: 'freee' } },
          { property: 'ソース', select: { equals: '直接' } },
        ]
      });
    } else if (channel === 'goooods') {
      filters.push({ property: 'ソース', select: { equals: 'goooods' } });
    }

    // フォロー状況フィルター
    if (followStatus && followStatus !== 'all') {
      filters.push({ property: 'フォロー状況', select: { equals: followStatus } });
    }

    const queryBody = {
      sorts: [{ property: '次回フォロー日', direction: 'ascending' }],
      page_size: 100,
    };
    if (filters.length > 0) {
      queryBody.filter = filters.length === 1 ? filters[0] : { and: filters };
    }

    // ページネーションで全件取得
    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;
    while (hasMore) {
      const reqBody = { ...queryBody };
      if (startCursor) reqBody.start_cursor = startCursor;

      const response = await fetch(
        `https://api.notion.com/v1/databases/${CLIENTS_DB_ID}/query`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(reqBody)
        }
      );
      const data = await response.json();
      if (data.error) { res.json(data); return; }
      allResults = allResults.concat(data.results || []);
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }
    res.json({ results: allResults });
  } catch (err) {
    console.error('Clients query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- 取引先フォロー日更新 ---
app.patch('/api/clients/update/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;
    const { nextFollowDate, followStatus, followType } = req.body;

    const properties = {};

    if (nextFollowDate) {
      properties['次回フォロー日'] = { date: { start: nextFollowDate } };
    }
    if (followStatus) {
      properties['フォロー状況'] = { select: { name: followStatus } };
    }
    if (followType && followType.length > 0) {
      properties['フォロー種別'] = { multi_select: followType.map(t => ({ name: t })) };
    }

    const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ properties })
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Clients update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Notion: ページにメール送信履歴を追記 ---
app.post('/api/notion/append-email/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;
    const { subject, body, senderName, date } = req.body;

    // 本文は300字に制限
    const trimmedBody = body.length > 300 ? body.slice(0, 300) + '...' : body;

    const children = [
      { object: 'block', type: 'divider', divider: {} },
      {
        object: 'block', type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: `📧 送信メール（${date}）` } }] }
      },
      {
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [
          { type: 'text', text: { content: '件名: ' }, annotations: { bold: true } },
          { type: 'text', text: { content: subject } }
        ] }
      },
      {
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: trimmedBody } }] }
      },
      {
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [
          { type: 'text', text: { content: `送信者: ${senderName}` }, annotations: { color: 'gray' } }
        ] }
      },
    ];

    const response = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ children })
    });

    const data = await response.json();
    if (data.object === 'error') {
      console.error('Notion append error:', data);
      return res.status(400).json({ error: data.message });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Notion append-email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- 取引先向けメール生成 ---
app.post('/api/claude/generate-client', async (req, res) => {
  try {
    const { clientInfo, senderId } = req.body;
    const sender = SENDER_ACCOUNTS.find(s => s.id === senderId) || SENDER_ACCOUNTS[1];

    const systemPrompt = `あなたはHIKOBAYUというアロマ・スキンケアブランドの営業担当です。
既存取引先への案内メールを日本語で作成してください。

【取引先情報】
- 企業名: ${clientInfo.name}
- 担当者: ${clientInfo.contact}
- チャネル: ${clientInfo.channel}（freee=直接取引 / goooods=goooods経由）
- 直近の取引: ${clientInfo.orderHistory}（${clientInfo.lastOrderDate}）
- 案内種別: ${(clientInfo.followTypes || []).join('、')}
- メモ: ${clientInfo.memo || 'なし'}
- 補足: ${clientInfo.extraContext || 'なし'}

【案内する内容】（attachmentsから選ばれたものをメール末尾にURLで記載）
- HIKOBAYUコンセプト資料
- Ambient Scent（ASシリーズ）紹介
- WAシリーズ紹介
- 卸価格表

【チャネル別の注意点】
- freee/直接取引の場合: 直接卸価格を案内。「いつもありがとうございます」から始める。
- goooods経由の場合: goooods上の価格と直接取引価格の両方に触れる。goooods外での直接取引の提案も可。

【トーン】
- 押しつけがましくない。森・自然・香りのブランドらしい柔らかい文体。
- 長すぎない（300字以内の本文）。
- 件名は短く具体的に。
- 署名は「${sender.signature}」で固定

必ずJSON形式のみで返してください:
{"subject": "件名", "body": "本文"}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: `上記の取引先情報をもとに、フォローアップメールを生成してください。本日は${new Date().toISOString().split('T')[0]}です。` }]
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Claude client generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HIKOBAYU Follow List: http://localhost:${PORT}`);
});
