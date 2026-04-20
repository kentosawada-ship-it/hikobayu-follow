require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const app = express();
app.use(express.static('.'));
app.use('/icons', express.static(path.join(__dirname, 'public/icons')));
app.use(express.json());

// --- Gmail OAuth2 設定 ---
const GMAIL_TOKENS_FILE = path.join(__dirname, 'gmail-tokens.json');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.OAUTH_REDIRECT_URL || 'http://localhost:3000/oauth2callback'
);

function loadGmailTokens() {
  // ファイルから読む（ローカル開発）
  let tokens = {};
  try { tokens = JSON.parse(fs.readFileSync(GMAIL_TOKENS_FILE, 'utf8')); } catch {}

  // 環境変数の refresh_token で上書き（Render 本番 / 永続化対応）
  // 環境変数名: GMAIL_REFRESH_TOKEN_COMPANY / GMAIL_REFRESH_TOKEN_KAYO / GMAIL_REFRESH_TOKEN_KENTO
  for (const { id } of SENDER_ACCOUNTS) {
    const rt = process.env[`GMAIL_REFRESH_TOKEN_${id.toUpperCase()}`];
    if (rt) tokens[id] = { ...(tokens[id] || {}), refresh_token: rt };
  }
  return tokens;
}

function saveGmailTokens(senderId, tokens) {
  try {
    const all = loadGmailTokens();
    all[senderId] = tokens;
    fs.writeFileSync(GMAIL_TOKENS_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    // Render 等のエフェメラルファイルシステムでは保存失敗しても動作継続
    console.warn('gmail-tokens 保存スキップ（環境変数の refresh_token を使用）');
  }
}

// OAuth2 認証URL生成
app.get('/api/auth/google', (req, res) => {
  const { senderId } = req.query;
  if (!senderId) return res.status(400).send('senderId が必要です');
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.compose'],
    state: senderId,
  });
  res.redirect(url);
});

// OAuth2 コールバック
app.get('/oauth2callback', async (req, res) => {
  const { code, state: senderId } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    saveGmailTokens(senderId, tokens);
    const sender = SENDER_ACCOUNTS.find(s => s.id === senderId);
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h2>✅ 認証完了</h2>
        <p>${sender?.label || senderId} の Gmail API 認証が完了しました。</p>
        <p>このタブを閉じてください。</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('認証エラー: ' + err.message);
  }
});

// Gmail API で下書き作成
app.post('/api/create-gmail-draft', async (req, res) => {
  try {
    const { to, subject, htmlBody: rawHtmlBody, senderId, clientId,
            companyName, contactName } = req.body;

    // 宛名（企業名・担当者名の両方が揃っている場合のみ）
    const addressee = (companyName && contactName)
      ? `${companyName} ${contactName}様` : null;

    // To 表示名: 宛名あり→「企業名 担当者名様 <email>」
    const toField = addressee ? `${addressee} <${to}>` : to;

    // HTML本文先頭に宛名段落を挿入
    let htmlBody = rawHtmlBody;
    if (addressee) {
      const safe = addressee.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const addresseeHtml = `<p style="margin:0 0 16px;font-size:15px;color:#333333;line-height:1.8;">${safe}</p>`;
      htmlBody = htmlBody.replace(
        /(style="padding:32px 40px;[^"]*">)/,
        `$1${addresseeHtml}\n`
      );
    }

    // 除外対象への送信を二重ブロック（clientId が渡された場合のみ）
    if (clientId) {
      const pageRes = await fetch(`https://api.notion.com/v1/pages/${clientId}`, {
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
        }
      });
      const page = await pageRes.json();
      const category = page.properties?.['取引区分']?.select?.name || '';
      if (EXCLUDED_CATEGORIES.includes(category)) {
        return res.status(403).json({
          error: `送信不可：取引区分「${category}」は送信対象外です（誤送信防止）`
        });
      }
    }

    const senderAccount = SENDER_ACCOUNTS.find(s => s.id === senderId);
    const tokens = loadGmailTokens()[senderId];
    if (!tokens) {
      return res.status(401).json({
        error: `${senderId} の認証が未完了です。`,
        authUrl: `/api/auth/google?senderId=${senderId}`
      });
    }

    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.OAUTH_REDIRECT_URL || 'http://localhost:3000/oauth2callback'
    );
    client.setCredentials(tokens);

    // トークン自動更新をキャッチして保存
    client.on('tokens', (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      saveGmailTokens(senderId, merged);
    });

    const gmail = google.gmail({ version: 'v1', auth: client });

    // MIME メッセージ組み立て
    const ccAddresses = (senderAccount?.cc || []).join(', ');
    const mimeLines = [
      'Content-Type: text/html; charset=UTF-8',
      'MIME-Version: 1.0',
      `To: ${encodeAddressHeader(toField)}`,
      ...(ccAddresses ? [`Cc: ${encodeAddressHeader(ccAddresses)}`] : []),
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      '',
      htmlBody,
    ];
    const raw = Buffer.from(mimeLines.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const draft = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } },
    });

    // authuser で送信アカウントを指定し、messageId で特定の下書きを直接開く
    // mail.google.com/mail/#drafts/xxx はリダイレクト時にhashが落ちるため authuser 付きで指定
    const draftUrl = `https://mail.google.com/mail/?authuser=${encodeURIComponent(senderAccount.email)}#drafts/${draft.data.message.id}`;
    res.json({ ok: true, draftUrl });
  } catch (err) {
    console.error('create-gmail-draft error:', err);
    res.status(500).json({ error: err.message });
  }
});


const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const CLIENTS_DB_ID = '748fc885-8796-49a2-8d91-aa1c131f8b58';
const CONTACTS_DB_ID = '7d9642c7-55ec-4d2e-913d-f8f10e4f82b1';
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// 送信除外カテゴリ（ハードコード・UI変更不可）
const EXCLUDED_CATEGORIES = ['原料仕入先', '製造委託先'];

// RFC 2047 エンコード（非ASCII文字を含む宛先表示名を Base64 エンコード）
function encodeMailAddress(address) {
  const match = address.trim().match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (!match) return address.trim();
  const name = match[1].trim();
  const email = match[2].trim();
  if (!/[^\x00-\x7F]/.test(name)) return `${name} <${email}>`;
  return `=?UTF-8?B?${Buffer.from(name).toString('base64')}?= <${email}>`;
}

function encodeAddressHeader(header) {
  return header.split(',').map(a => encodeMailAddress(a)).join(', ');
}

// HTMLタグ除去
function stripHtml(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// 日付文字列(YYYY-MM-DD)にn日加算
function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// 今日の日付をJSTで返す(YYYY-MM-DD)
function getTodayJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().split('T')[0];
}

// --- 送信アドレス設定 ---
const SENDER_ACCOUNTS = [
  { id: 'company', label: 'HIKOBAYU（会社）', email: process.env.EMAIL_COMPANY || 'info@hikobayu.com',         signature: 'HIKOBAYU', cc: ['someco@hikobayu.com', 'kento.sawada@hikobayu.com'], appPassword: process.env.GMAIL_APP_PASSWORD_COMPANY || '' },
  { id: 'kayo',    label: '澤田佳代子',       email: process.env.EMAIL_KAYO    || 'someco@hikobayu.com',        signature: 'HIKOBAYU', cc: ['info@hikobayu.com', 'kento.sawada@hikobayu.com'],  appPassword: process.env.GMAIL_APP_PASSWORD_KAYO    || '' },
  { id: 'kento',   label: '澤田健人',         email: process.env.EMAIL_KENTO   || 'kento.sawada@hikobayu.com', signature: 'HIKOBAYU', cc: ['info@hikobayu.com', 'someco@hikobayu.com'],         appPassword: process.env.GMAIL_APP_PASSWORD_KENTO   || '' },
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

// --- メール送信後の統合記録（コンタクト履歴 + 取引先マスター更新）---
// Gmail送信成功後に呼ぶ。Notion失敗は warnings で返し、送信自体は成功扱い。
app.post('/api/record-email-sent', async (req, res) => {
  const { clientId, clientName, bodyHtml, subject, sentDate,
          senderEmail, contactEmail, templateNames, attachNames } = req.body;

  const plainBody = stripHtml(bodyHtml).substring(0, 200);
  const nextFollowDate = addDaysToDateStr(sentDate || getTodayJST(), 7);
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const warnings = [];

  // 1. コンタクト履歴に新規ページ作成
  try {
    const title = `${sentDate} ${clientName} メール送信`;
    const memoLines = [];
    if (plainBody)      memoLines.push(`本文（冒頭）: ${plainBody}`);
    if (subject)        memoLines.push(`件名: ${subject}`);
    if (senderEmail)    memoLines.push(`送信者: ${senderEmail}`);
    if (contactEmail)   memoLines.push(`送信先メール: ${contactEmail}`);
    if (templateNames)  memoLines.push(`使用定型文: ${templateNames}`);
    if (attachNames)    memoLines.push(`添付資料: ${attachNames}`);
    memoLines.push(`送信日時: ${now}`);

    const properties = {
      'タイトル':      { title:     [{ text: { content: title } }] },
      '取引先':        { relation:  [{ id: clientId }] },
      '接触日':        { date:      { start: sentDate || getTodayJST() } },
      '接触種別':      { select:    { name: 'メール送信' } },
      'レスポンス有無':{ select:    { name: 'レスポンスなし' } },
      '内容メモ':      { rich_text: [{ text: { content: memoLines.join('\n').slice(0, 2000) } }] },
      '次回フォロー日':{ date:      { start: nextFollowDate } },
    };

    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parent: { database_id: CONTACTS_DB_ID }, properties }),
    });
    const d = await r.json();
    if (d.object === 'error') throw new Error(d.message);
  } catch (err) {
    console.error('record-email-sent: contact_history error:', err.message);
    warnings.push({ step: 'contact_history', error: err.message });
  }

  // 2. 取引先マスター更新（前回フォロー日・次回フォロー日・前回の対応内容）
  try {
    const r = await fetch(`https://api.notion.com/v1/pages/${clientId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          '前回フォロー日':   { date:      { start: sentDate || getTodayJST() } },
          '次回フォロー日':   { date:      { start: nextFollowDate } },
          '前回の対応内容':   { rich_text: [{ text: { content: plainBody } }] },
        },
      }),
    });
    const d = await r.json();
    if (d.object === 'error') throw new Error(d.message);
  } catch (err) {
    console.error('record-email-sent: partner_update error:', err.message);
    warnings.push({ step: 'partner_update', error: err.message });
  }

  res.json({ success: true, warnings });
});

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

// --- HTMLメールテンプレート CRUD ---
const EMAIL_TEMPLATES_FILE = path.join(__dirname, 'email-templates.json');

function loadEmailTemplates() {
  try { return JSON.parse(fs.readFileSync(EMAIL_TEMPLATES_FILE, 'utf8')); }
  catch { return []; }
}

function saveEmailTemplates(data) {
  fs.writeFileSync(EMAIL_TEMPLATES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

app.get('/api/email-templates', (req, res) => res.json(loadEmailTemplates()));

app.post('/api/email-templates', (req, res) => {
  const list = loadEmailTemplates();
  const item = { id: Date.now().toString(), ...req.body };
  list.push(item);
  saveEmailTemplates(list);
  res.json(item);
});

app.put('/api/email-templates/:id', (req, res) => {
  const list = loadEmailTemplates();
  const idx = list.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  list[idx] = { ...list[idx], ...req.body };
  saveEmailTemplates(list);
  res.json(list[idx]);
});

app.delete('/api/email-templates/:id', (req, res) => {
  let list = loadEmailTemplates();
  list = list.filter(t => t.id !== req.params.id);
  saveEmailTemplates(list);
  res.json({ ok: true });
});

// --- 署名テンプレート ---
const SIGNATURES = {
  company: `
    合同会社HIKOBAYU<br>
    62-3 Motomachi, Niseko, Hokkaido<br>
    <span style="color:#c8bfb0">─────────────────</span><br>
    info@hikobayu.com<br>
    hikobayu.com
  `,
  kayo: `
    澤田 佳代子 &nbsp; Kayoko Sawada<br>
    合同会社HIKOBAYU &nbsp; 代表<br>
    <span style="color:#c8bfb0">─────────────────</span><br>
    62-3 Motomachi, Niseko, Hokkaido<br>
    someco@hikobayu.com<br>
    hikobayu.com
  `,
  kento: `
    澤田 健人 &nbsp; Kento Sawada<br>
    合同会社HIKOBAYU &nbsp; Director<br>
    <span style="color:#c8bfb0">─────────────────</span><br>
    62-3 Motomachi, Niseko, Hokkaido<br>
    kento.sawada@hikobayu.com<br>
    hikobayu.com
  `,
};

// --- HTML メール構築 ---
function buildHtmlEmail(bodyHtml, imageUrl, senderId) {
  const imageSection = imageUrl
    ? `<div style="margin:16px 0;"><img src="${imageUrl}" alt="" style="display:block;width:100%;max-width:100%;height:auto;border:0;"></div>`
    : '';

  const styledBody = bodyHtml
    .replace(/<p>/g, '<p style="margin:0 0 16px;font-size:15px;color:#333333;line-height:1.8;">')
    .replace(/<p /g, '<p style="margin:0 0 16px;font-size:15px;color:#333333;line-height:1.8;" ')
    .replace(/<ul>/g, '<ul style="margin:0 0 16px;padding-left:20px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 16px;padding-left:20px;">')
    .replace(/<li>/g, '<li style="margin:0 0 4px;">');

  const signature = SIGNATURES[senderId] || SIGNATURES.company;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f9f9f7;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f9f9f7">
    <tr>
      <td align="center" style="padding:32px 16px 32px;">
        <table cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;">
          <tr>
            <td align="center" style="padding:32px 40px 24px;border-bottom:1px solid #f0ede8;">
              <img src="https://cdn.shopify.com/s/files/1/0608/7904/4846/files/logo_hikobayu_c468359f-75fc-4852-9a09-8c1331fadb24.png?v=1760691427" width="160" alt="HIKOBAYU" style="display:block;max-width:160px;height:auto;border:0;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 40px;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Noto Sans JP',Helvetica,Arial,sans-serif;font-size:15px;color:#333333;line-height:1.8;">
              ${styledBody}
              ${imageSection}
            </td>
          </tr>
          <tr>
            <td align="center" style="font-family:Georgia,serif;font-size:12px;color:#7a7060;line-height:1.8;padding:24px 20px 24px;border-top:1px solid #f0ede8;background-color:#f9f7f4;">
              ${signature}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// --- Gmail下書き準備（compose URL + HTMLクリップボード用） ---
app.post('/api/prepare-gmail-draft', async (req, res) => {
  try {
    const { to, subject, bodyHtml, imageUrl, senderId, facilityName, contactName } = req.body;

    const sender = SENDER_ACCOUNTS.find(s => s.id === senderId);
    if (!sender) return res.status(400).json({ error: '送信者が見つかりません' });

    // 変数置換
    const vars = { facility_name: facilityName || '', name: contactName || '' };
    const finalSubject = (subject || '')
      .replace(/\{\{facility_name\}\}/g, vars.facility_name)
      .replace(/\{\{name\}\}/g, vars.name);
    const finalBodyHtml = (bodyHtml || '')
      .replace(/\{\{facility_name\}\}/g, vars.facility_name)
      .replace(/\{\{name\}\}/g, vars.name);

    const htmlEmail = buildHtmlEmail(finalBodyHtml, imageUrl, senderId);

    // Gmail compose URL（to・subject・authuser を自動セット）
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(finalSubject)}&authuser=${encodeURIComponent(sender.email)}&tf=1`;

    res.json({ ok: true, gmailUrl, htmlEmail });
  } catch (err) {
    console.error('prepare-gmail-draft error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- 送信完了後のNotion記録 ---
app.post('/api/log-email-sent', async (req, res) => {
  try {
    const { clientId, clientName, subject, contactDate } = req.body;

    const properties = {
      'タイトル': { title: [{ text: { content: `${contactDate} ${clientName} メール送信` } }] },
      '接触日': { date: { start: contactDate } },
      '接触種別': { select: { name: 'メール送信' } },
      'レスポンス有無': { select: { name: '未確認' } },
    };

    if (clientId) {
      properties['取引先'] = { relation: [{ id: clientId }] };
    }
    if (subject) {
      properties['内容メモ'] = { rich_text: [{ text: { content: `件名: ${subject}` } }] };
    }

    const CONTACTS_DB_ID = '7d9642c7-55ec-4d2e-913d-f8f10e4f82b1';
    const response = await fetch(`https://api.notion.com/v1/pages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: CONTACTS_DB_ID },
        properties
      })
    });

    const data = await response.json();
    res.json({ ok: true, data });
  } catch (err) {
    console.error('log-email-sent error:', err);
    res.status(500).json({ error: err.message });
  }
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
    const sender = SENDER_ACCOUNTS.find(s => s.id === senderId) || SENDER_ACCOUNTS[0]; // デフォルト佳代

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
        model: CLAUDE_MODEL,
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
    const { channel, stage } = req.body || {};
    const filters = [];

    // チャネルフィルター
    if (channel === 'freee') {
      filters.push({ property: 'ソース', select: { equals: '直接' } });
    } else if (channel === 'goooods') {
      filters.push({ property: 'ソース', select: { equals: 'goooods' } });
    }

    // ステージフィルター
    if (stage && stage !== 'all') {
      filters.push({ property: 'ステージ', select: { equals: stage } });
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
      if (data.object === 'error') {
        console.error('Notion API error:', data.code, data.message);
        return res.status(502).json({ error: `Notion: ${data.message}`, code: data.code });
      }
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
    const { nextFollowDate, lastFollowDate, nextAction } = req.body;

    const properties = {};

    if (nextFollowDate) {
      properties['次回フォロー日'] = { date: { start: nextFollowDate } };
    }
    if (lastFollowDate) {
      properties['前回フォロー日'] = { date: { start: lastFollowDate } };
    }
    if (nextAction) {
      properties['次のアクション'] = { rich_text: [{ text: { content: nextAction } }] };
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

// --- コンタクト履歴 作成 ---
app.post('/api/contacts/create', async (req, res) => {
  try {
    const { clientId, clientName, subject, contactDate,
            templateNames, attachNames, senderEmail, contactEmail } = req.body;

    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const memoLines = [`件名: ${subject || ''}`, `送信日時: ${now}`];
    if (senderEmail) memoLines.push(`送信者: ${senderEmail}`);
    if (contactEmail) memoLines.push(`送信先メール: ${contactEmail}`);
    if (templateNames) memoLines.push(`使用定型文: ${templateNames}`);
    if (attachNames)   memoLines.push(`添付資料: ${attachNames}`);
    const memo = memoLines.join('\n');

    const properties = {
      'タイトル': { title: [{ text: { content: `${contactDate} ${clientName} メール送信` } }] },
      '接触日': { date: { start: contactDate } },
      '接触種別': { select: { name: 'メール送信' } },
      'レスポンス有無': { select: { name: '未確認' } },
      '内容メモ': { rich_text: [{ text: { content: memo.slice(0, 2000) } }] },
    };

    if (clientId) {
      properties['取引先'] = { relation: [{ id: clientId }] };
    }

    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: CONTACTS_DB_ID },
        properties
      })
    });

    const data = await response.json();
    if (data.object === 'error') {
      console.error('Contact create error:', data);
      return res.status(400).json({ error: data.message });
    }
    res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('Contacts create error:', err);
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
    const sender = SENDER_ACCOUNTS.find(s => s.id === senderId) || SENDER_ACCOUNTS[0];

    const systemPrompt = `あなたはHIKOBAYUというアロマ・スキンケアブランドの営業担当です。
既存取引先への案内メールを日本語で作成してください。

【取引先情報】
- 企業名: ${clientInfo.name}
- 担当者: ${clientInfo.contact || '（不明）'}
- チャネル: ${clientInfo.channel || '（不明）'}（freee=直接取引 / goooods=goooods経由）
- 業態: ${clientInfo.business || 'なし'}
- ステージ: ${clientInfo.stage || 'なし'}
- 取引商品: ${clientInfo.orderHistory || 'なし'}
- 前回の対応内容: ${clientInfo.previousAction || 'なし'}
- メモ: ${clientInfo.memo || 'なし'}
- 定型文・補足内容: ${clientInfo.extraContext || 'なし'}
- 添付予定資料: ${clientInfo.attachNames || 'なし'}
- 添付資料URL: ${clientInfo.attachLinks || 'なし'}

【チャネル別の注意点】
- freee/直接取引の場合: 直接卸価格を案内。「いつもありがとうございます」から始める。
- goooods経由の場合: goooods上の価格と直接取引価格の両方に触れる。goooods外での直接取引の提案も可。

【トーン】
- 押しつけがましくない。森・自然・香りのブランドらしい柔らかい文体。
- 長すぎない（300字以内の本文）。
- 件名は短く具体的に。
- 署名は「${sender.signature}」で固定

【宛名のルール】
- 宛名は本文の冒頭に「企業名 担当者名様」の形式で書くこと。例：「クロスポイント 児島様」
- 企業名・担当者名の両方が揃っている場合のみ宛名行を入れる。どちらかが欠けている場合は宛名なしで本文を書く。
- 担当者名が「名 姓」順で入力されていたら「姓 名」に直す。

【添付資料のルール】
- 添付資料URLが「なし」以外の場合、文脈に応じて自然な場所にリンクを差し込むこと（「資料名：URL」形式）
- 差し込む位置はAIが判断してよい（文末、該当トピックの直後など）
- 必ず全ての指定資料のリンクが本文に含まれること
- 複数資料がある場合、関連するものは近い位置にまとめてもよい
- 一律の【ご参考資料】セクションは作らないこと

必ずJSON形式のみで返してください（前後に余計な文字を入れないこと）:
{"subject": "件名", "body": "本文"}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
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

// --- 対応内容AI要約（キャッシュ付き）---
const _summaryCache = new Map(); // hash → summary

function hashText(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (Math.imul(31, h) + str.charCodeAt(i)) | 0; }
  return h.toString();
}

app.post('/api/summarize-contact', async (req, res) => {
  const { memo } = req.body;
  if (!memo || memo.trim().length < 10) return res.json({ summary: null });

  const key = hashText(memo);
  if (_summaryCache.has(key)) return res.json({ summary: _summaryCache.get(key) });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `以下は取引先への対応メモです。1〜2行で要約し、「次に何を伝えるべきか」が分かる形にしてください。\n\n${memo}`
        }]
      })
    });
    const data = await response.json();
    const summary = data.content?.[0]?.text?.trim() || null;
    if (summary) _summaryCache.set(key, summary);
    res.json({ summary });
  } catch (err) {
    res.json({ summary: null });
  }
});

const PORT = process.env.PORT || 3000;
// --- コンタクト履歴 最新1件取得 ---
app.get('/api/contacts/latest/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;

    const response = await fetch(
      `https://api.notion.com/v1/databases/${CONTACTS_DB_ID}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filter: {
            property: '取引先',
            relation: { contains: clientId }
          },
          sorts: [{ property: '接触日', direction: 'descending' }],
          page_size: 1
        })
      }
    );

    const data = await response.json();
    if (data.object === 'error') {
      return res.status(400).json({ error: data.message });
    }

    const results = data.results || [];
    if (results.length === 0) {
      return res.json({ memo: null, date: null, type: null });
    }

    const page = results[0];
    const props = page.properties;
    const memo = props['内容メモ']?.rich_text?.[0]?.plain_text || null;
    const date = props['接触日']?.date?.start || null;
    const type = props['接触種別']?.select?.name || null;

    res.json({ memo, date, type });
  } catch (err) {
    console.error('Contacts latest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- コンタクト履歴一覧取得 ---
app.get('/api/contacts/list', async (req, res) => {
  try {
    const pageSize = parseInt(req.query.limit) || 50;
    const response = await fetch(
      `https://api.notion.com/v1/databases/${CONTACTS_DB_ID}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sorts: [{ property: '接触日', direction: 'descending' }],
          page_size: pageSize
        })
      }
    );
    const data = await response.json();
    if (data.object === 'error') return res.status(400).json({ error: data.message });

    const results = (data.results || []).map(page => {
      const p = page.properties;
      const memo = p['内容メモ']?.rich_text?.[0]?.plain_text || '';
      // 内容メモからフィールドをパース
      const parse = (label) => {
        const m = memo.match(new RegExp(`${label}: (.+)`));
        return m ? m[1].trim() : '';
      };
      return {
        id: page.id,
        title: p['タイトル']?.title?.[0]?.plain_text || '',
        contactDate: p['接触日']?.date?.start || '',
        clientId: p['取引先']?.relation?.[0]?.id || '',
        subject: parse('件名'),
        sentAt: parse('送信日時'),
        senderEmail: parse('送信者'),
        contactEmail: parse('送信先メール'),
        templateNames: parse('使用定型文'),
        attachNames: parse('添付資料'),
      };
    });

    res.json({ results });
  } catch (err) {
    console.error('contacts/list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- 今日送信済みの取引先IDリスト ---
app.get('/api/sent-today', async (req, res) => {
  try {
    const todayStr = new Date().toISOString().split('T')[0];
    const response = await fetch(
      `https://api.notion.com/v1/databases/${CONTACTS_DB_ID}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filter: { property: '接触日', date: { equals: todayStr } },
          page_size: 100
        })
      }
    );
    const data = await response.json();
    if (data.object === 'error') return res.status(502).json({ error: data.message });

    const clientIds = [...new Set(
      (data.results || [])
        .map(p => p.properties['取引先']?.relation?.[0]?.id)
        .filter(Boolean)
    )];
    res.json({ clientIds });
  } catch (err) {
    console.error('sent-today error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- 空レコード削除 ---
app.post('/api/clients/delete-empty', async (req, res) => {
  try {
    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const reqBody = { page_size: 100 };
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
      allResults = allResults.concat(data.results || []);
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    const emptyPages = allResults.filter(page => {
      const p = page.properties;
      const name = p['企業名']?.title?.[0]?.plain_text || '';
      const contact = p['担当者名']?.rich_text?.[0]?.plain_text || '';
      const email = p['メールアドレス']?.email || '';
      return !name && !contact && !email;
    });

    console.log(`空レコード: ${emptyPages.length}件 削除します`);

    const results = [];
    for (const page of emptyPages) {
      console.log(`  削除: ${page.id}`);
      const r = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ archived: true })
      });
      const d = await r.json();
      results.push({ id: page.id, ok: d.object === 'page' });
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    res.json({ deleted: results.length, results });
  } catch (err) {
    console.error('Delete empty error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`HIKOBAYU Follow List: http://localhost:${PORT}`);

  // --- Browser-Sync: 別PCからも自動リロード ---
  if (process.env.NODE_ENV !== 'production') {
    try {
      const bs = require('browser-sync').create();
      bs.init({
        proxy: `localhost:${PORT}`,
        port: 3001,
        ui: { port: 3002 },
        files: [
          '*.html',
          'public/**/*',
          '*.css',
          '*.js',
          '!node_modules/**',
        ],
        open: false,
        notify: true,
        // LAN上の別PCからアクセス可能にする
        // 妻のPCから http://<このPCのIP>:3001 でアクセス
        listen: '0.0.0.0',
      });
      const os = require('os');
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            console.log(`  LAN access: http://${net.address}:3001`);
          }
        }
      }
    } catch (e) {
      console.log('browser-sync not available, skipping:', e.message);
    }
  }
});
