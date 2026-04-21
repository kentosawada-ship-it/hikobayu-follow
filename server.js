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

// Render 環境変数を API 経由で自動更新（OAuth 再認証後の永続化）
async function updateRenderEnvVar(key, value) {
  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;
  if (!apiKey || !serviceId) {
    console.log(`[Render] RENDER_API_KEY / RENDER_SERVICE_ID 未設定 → env var "${key}" の自動更新をスキップ`);
    return;
  }
  try {
    // 現在の env var 一覧を取得
    const listRes = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
    });
    if (!listRes.ok) throw new Error(`Render API GET failed: ${listRes.status}`);
    const envVars = await listRes.json();

    // 対象キーを更新（なければ追加）。マスクされた値は process.env から補完して上書きを防ぐ
    let found = false;
    const updated = envVars.map(e => {
      if (e.key === key) { found = true; return { key: e.key, value }; }
      return { key: e.key, value: e.value || process.env[e.key] || '' };
    });
    if (!found) updated.push({ key, value });

    const putRes = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(updated)
    });
    if (!putRes.ok) throw new Error(`Render API PUT failed: ${putRes.status}`);
    console.log(`[Render] env var "${key}" を自動更新しました ✅`);
  } catch (err) {
    console.warn(`[Render] env var 更新失敗（手動設定が必要）: ${err.message}`);
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

    // refresh_token が得られた場合、Render env var を自動更新（再起動後も有効になる）
    let renderUpdated = false;
    if (tokens.refresh_token) {
      const envKey = `GMAIL_REFRESH_TOKEN_${senderId.toUpperCase()}`;
      await updateRenderEnvVar(envKey, tokens.refresh_token);
      renderUpdated = !!(process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID);
    }

    const sender = SENDER_ACCOUNTS.find(s => s.id === senderId);
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h2>✅ 認証完了</h2>
        <p>${sender?.label || senderId} の Gmail API 認証が完了しました。</p>
        ${renderUpdated
          ? '<p style="color:#16a34a;">🔒 Render の環境変数も自動更新済み。再起動後も有効です。</p>'
          : '<p style="color:#888;font-size:13px;">（RENDER_API_KEY / RENDER_SERVICE_ID が未設定のため、手動での env var 更新が必要です）</p>'
        }
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
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const CLIENTS_DB_ID = '748fc885-8796-49a2-8d91-aa1c131f8b58';
const CONTACTS_DB_ID = '7d9642c7-55ec-4d2e-913d-f8f10e4f82b1';

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
