require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.static('.'));
app.use(express.json());

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const NOTION_DB_ID = process.env.NOTION_DB_ID;

// --- Notion: 今日のフォロー案件を取得 ---
app.post('/api/notion/query', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
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
          filter: {
            and: [
              {
                property: '次回フォロー日',
                date: { on_or_before: today }
              },
              {
                property: 'ステータス',
                multi_select: { does_not_contain: '成約' }
              },
              {
                property: 'ステータス',
                multi_select: { does_not_contain: '保留' }
              }
            ]
          },
          sorts: [
            { property: '次回フォロー日', direction: 'ascending' }
          ]
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
    const { caseInfo } = req.body;

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

    const systemPrompt = `あなたはHIKOBAYUというアロマ・スキンケアブランドの営業担当アシスタントです。
HIKOBAYUのブランドコア：「日常に、森へ還る時間をつくる。呼吸が深まり、余白がひらく。森へと還る、小さな儀式。」
北海道ニセコのトドマツ精油を使ったスキンケア・アロマ製品を販売しています。

【メール生成ルール】
- 売り込まない。森の時間に誘う語り口
- 簡潔・温かみ・具体性のバランスを保つ
- 署名は「HIKOBAYU　澤田佳代子」で固定
- 「次のアクション」に書かれた内容を最優先でメールに反映すること
- 「ミーティングメモ」がある場合はその内容を必ず盛り込む

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HIKOBAYU Follow List: http://localhost:${PORT}`);
});
