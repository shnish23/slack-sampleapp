import axios from 'axios';
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { WebClient } from '@slack/web-api';
import { createHmac, timingSafeEqual } from 'crypto';

// Slack BotのトークンとAIモデルIDを環境変数から読み込む
const slackBotToken = process.env.SLACK_BOT_TOKEN;
const modelId = process.env.CLAUDE_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0';
const characterConfiguration = process.env.CHARACTER_CONFIG || 'あなたは優れたAIアシスタントとしてユーザーの質問に答えます';
const characterThinkingText = process.env.CHARACTER_THINKING_TEXT || 'Loading';
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
 
// AWSとSlackのクライアントを初期化
const awsClient = new BedrockRuntimeClient({ region: 'us-east-1' });
const slackClient = new WebClient(slackBotToken);

// Slack リクエストの署名を検証する関数
function verifySlackRequestSignature(event) {
  const requestSignature = event.headers['x-slack-signature'];
  const requestTimestamp = event.headers['x-slack-request-timestamp'];
   
  // 5分以上前のタイムスタンプを持つリクエストは無視
  const time = Math.floor(new Date().getTime() / 1000);
  if (Math.abs(time - requestTimestamp) > 300) {
    return false;
  }
 
  // 署名基盤文字列を作成
  const sigBasestring = `v0:${requestTimestamp}:${event.body}`;
  const mySignature = `v0=` + 
    createHmac('sha256', slackSigningSecret)
          .update(sigBasestring, 'utf8')
          .digest('hex');
 
  // 計算した署名とSlackから受け取った署名を比較
  return timingSafeEqual(Buffer.from(mySignature, 'utf8'), Buffer.from(requestSignature, 'utf8'));
}

// 画像を取得する
async function getFile(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${slackBotToken}`
      }
    });
    const myBuffer = Buffer.from(response.data)
    const base64 = myBuffer.toString('base64')
    return base64;
  } catch (error) {
      console.error('Error fetching image:', error.message);
      throw(error);
  }
}

// Slackのスレッドからプロンプトを生成する関数
async function generatePromptsFromSlackHistory(slackEvent) {
  const prompts = []; // プロンプトを格納する配列
  let previousRole = "user"; // 前のメッセージのロールを追跡

  // スレッドのメッセージかどうかを判定
  const isThread = slackEvent.thread_ts && slackEvent.thread_ts !== slackEvent.ts;
  const targetTs = isThread ? slackEvent.thread_ts : slackEvent.ts;
  
  // Slack APIを使ってスレッドのメッセージを取得
  const response = await slackClient.conversations.replies({ channel: slackEvent.channel, ts: targetTs });
  console.log(JSON.stringify({ event: "slackThreadSearched", messages: response.messages }));
   
    // 最後のメッセージがBotからのものなら削除
    if (response.messages && response.messages[response.messages.length - 1].bot_id) {
    response.messages.pop();
  }
  
  // メッセージが空かBotからのものだけなら、ユーザーメッセージを強制的に挿入
  if (response.messages.length === 0 || response.messages[0].bot_id) {
    prompts.push({ role: "user", content: "----" });
  }
  
  // メッセージごとにプロンプトを生成
  await Promise.all(response.messages.map(async (message) => {
    const role = message.bot_id ? 'assistant' : 'user';
    let content = message.text;
    // アタッチメントがある場合は含める
    if (message.attachments) {
      content += message.attachments.map(a => `\n[Attachments]\n${JSON.stringify(a)}`).join("\n");
    }
  
    // 前のメッセージと同じロールの場合はテキストを結合
    if (prompts.length > 0 && role === previousRole) {
      prompts[prompts.length - 1].content += `\n----\n${content}`;
    } else {
      prompts.push({ role, content });
    }
    previousRole = role;

    // 添付ファイルがある場合
    if (message.files) {
      prompts[prompts.length - 1].content = [
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": message.files[0]?.mimetype,
            "data": await getFile(message.files[0]?.url_private)
          }
        },
        {
            "type": "text",
            "text": content
        }
      ];
    }
  }));      

  // 生成されたプロンプトをログに記録
  console.log(JSON.stringify({ event: "promptGenerated", prompts }));
  return prompts;
}

// AIモデルを呼び出してテキストを生成する関数
async function generateTextWithAI(prompts) {
  const command = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 2000,
      system: characterConfiguration,
      messages: prompts,
    }),
  });
 
  try {
    const response = await awsClient.send(command);
    const responseText = Buffer.from(response.body).toString('utf8');
    const parsedResponse = JSON.parse(responseText);
 
    // AIからの応答をログに記録
    console.log(JSON.stringify({ event: "aiResponseReceived", parsedResponse }));
    return { text: parsedResponse.content?.[0]?.text ?? "AIからの応答がありませんでした。", usage: parsedResponse.usage };
  } catch (error) {
    // AIモデル呼び出しエラーをログに記録
    console.error('Error calling AI model:', error);
    return { text: "AIモデルの呼び出し中にエラーが発生しました。", usage: {} };
  }
}
 
// 応答テキストを特定の長さで分割する関数
function splitTextIntoChunks(text, chunkSize) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.substring(i, i + chunkSize));
  }
  return chunks;
}
 
// トークン数と価格を計算する関数
function calculateTokenPrices(inputTokens, outputTokens) {
  const inputPricePer1000 = 0.00300;
  const outputPricePer1000 = 0.01500;
  const inputCost = inputTokens / 1000 * inputPricePer1000;
  const outputCost = outputTokens / 1000 * outputPricePer1000;
  return { inputCost, outputCost };
}
 
// SlackにAIの応答とトークン使用量を投稿する関数
async function postResponseWithTokenInfoToSlack(channel, responseText, initialResponseTs, usage) {
  const { inputCost, outputCost } = calculateTokenPrices(usage.input_tokens, usage.output_tokens);
  const totalPrice = inputCost + outputCost;
 
  // 応答テキストをSlackのメッセージブロックに分割
  const textChunks = splitTextIntoChunks(responseText, 3000);
  const blocks = textChunks.map(chunk => ({ type: "section", text: { type: "mrkdwn", text: chunk } }));
 
  // トークン使用量と想定価格を含むメッセージブロックを追加
  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `入力トークン数: ${usage.input_tokens}, 出力トークン数: ${usage.output_tokens}, 想定価格: $${totalPrice.toFixed(4)}` }
    ]
  });
 
  // Slackに応答を投稿
  await slackClient.chat.update({ channel: channel, ts: initialResponseTs, blocks: JSON.stringify(blocks), text: textChunks[0].slice(0, 2800) });
}

// Slackイベントを処理するメインの関数
export async function lambdaHandler(event) {
  if (!event.headers['x-slack-signature'] || !verifySlackRequestSignature(event)) {
    // 署名が不一致の場合の処理
    console.error('Verification failed', event);
    return { statusCode: 400, body: 'Verification failed' };
  }
  const body = JSON.parse(event.body);
 
  // URL検証リクエストに応答
  if (body.type === 'url_verification') {
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: body.challenge };
  }
 
  // リトライメッセージを無視
  if (event.headers['x-slack-retry-num']) {
    return { statusCode: 200 };
  }
 
  // Slackメンションを受信したイベントをログに記録
  const slackEvent = body.event;
  console.log(JSON.stringify({ event: "slackMentionReceived", slackEvent }));
  if (slackEvent.subtype === 'bot_message') {
    return { statusCode: 200 };
  }
 
  // 処理中のテキストをSlackに投稿
  let thinkingText = characterThinkingText;
  const initialResponse = await slackClient.chat.postMessage({ channel: slackEvent.channel, text: thinkingText, thread_ts: slackEvent.ts });
 
  // 処理中テキストの更新をスケジュール
  const interval = setInterval(async () => {
    thinkingText += "...";
    await slackClient.chat.update({ channel: slackEvent.channel, ts: initialResponse.ts, text: thinkingText });
  }, 2000);
 
  // Slackのスレッドからプロンプトを生成し、AIでテキストを生成
  const prompts = await generatePromptsFromSlackHistory(slackEvent);
  const { text: aiResponseText, usage } = await generateTextWithAI(prompts);
 
  // 処理中テキストの更新を停止し、結果をSlackに投稿
  clearInterval(interval);
  await postResponseWithTokenInfoToSlack(slackEvent.channel, aiResponseText, initialResponse.ts, usage);
 
  return { statusCode: 200 };
}

// export const lambdaHandler = async (event, context) => {
//     const response = {
//       statusCode: 200,
//       body: JSON.stringify({
//         message: 'hello world',
//       })
//     };

//     return response;
//   };
  