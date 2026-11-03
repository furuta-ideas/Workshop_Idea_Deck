# AIの認可とGateway契約

本書のGatewayは**本アプリが定義する接続アダプター**です。Gensparkの公開エンドポイントやGSKのAPI仕様を表すものではありません。

## 接続前に必要な情報

1. 契約管理者によるGSK/API利用可否の確認と正式ドキュメント。
2. 質問・分類・音声認識・議論要約・キーワード・画像生成の各機能の社内認可。会社で禁止された下流モデルへのルーティングも止めること。
3. 承認済みGatewayのHTTPS URL、サーバー用キー、承認根拠（社内申請ID等）。
4. 音声・議論・画像の送信先、保存期間、ログ、アクセス可能者の運用確認。

既定サービスIDは `genspark-enterprise`、モデルは空文字です。Genspark Enterprise契約があるだけでAPIや全機能の利用が認可されたとは扱いません。公式FAQにはGSK経由のAPI案内があり、詳細条件は問い合わせ対象となっています。[公式FAQ](https://www.genspark.ai/ja/business/faq)

## サーバーの許可リスト

`.env` の `AI_APPROVED_PROVIDERS` は次のJSON配列です。これは形式例であり、下記URL・認可根拠は実環境では使えません。

```json
[
  {
    "id": "genspark-enterprise",
    "label": "会社承認済みGenspark Gateway",
    "endpoint": "https://gateway.example.invalid/workshop-ai",
    "keyEnv": "WORKSHOP_AI_GATEWAY_KEY",
    "capabilities": ["questions", "classify", "transcribe", "summarize", "keywords", "image"],
    "approvalReference": "正式な社内承認の参照先を設定"
  }
]
```

認可済みの機能のみ `capabilities` に列挙します。キーの実値は別の環境変数に置き、JSONにもフロントにも渡しません。管理画面は許可リストのID・ラベル・認可機能・準備状態を参照し、モデルと画像プロンプトだけ編集できます。モデル制限がある契約ではGateway側でも許可モデルを検証してください。

接続URLはHTTPS固定、資格情報付きURL・クエリ・フラグメント不可、リダイレクト拒否、90秒タイムアウトです。失敗時は別サービスへのフォールバックも自動再送もしません。ブラウザーから外部AIへの直接通信はCSPで許可していません。

## リクエスト

`POST`、JSON、`Authorization: Bearer <server-key>`。

```json
{
  "requestId": "UUID",
  "task": "questions",
  "input": {
    "theme": "テーマ",
    "nodes": [],
    "deck": [],
    "discussion": {}
  }
}
```

`model` は設定時だけ追加し、未指定の場合はキー自体を送信しません。入力は要求したチームの内容だけです。音声は `input: {"audio":"BASE64", "mimeType":"audio/webm"}` のように送信します。画像の場合のみ、管理者が入力した `prompt` と `aspectRatio: "16:9"` を追加します。音声はブラウザーのMediaRecorderで取得し、標準SpeechRecognitionは使用しません。

## レスポンス

HTTP 2xx、JSON、12MB未満。以下の形式を返してください。

| task       | 形式                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| questions  | `{ "questions": ["質問1", "質問2"] }`                                                                              |
| classify   | `{ "groups": [{"name":"観点1", "nodeIds":["既存ノードID"]}] }`、最大8グループ                                      |
| transcribe | `{ "text": "文字起こし" }`                                                                                         |
| summarize  | `{ "what":"40文字以内", "who":"40文字以内", "how":"120文字以内", "points":"論点1\n論点2", "keywords":"語1、語2" }` |
| keywords   | `{ "keywords": "語1、語2" }`                                                                                       |
| image      | `{ "pngBase64": "PNGのBASE64" }`、横16:9、最大約8MB                                                                |

分類名はレビュー画面で参照でき、適用後は各分類を色グループへ反映します。ノードの親子関係を自動変更しません。音声を①で入力した場合は気づきのノードとして適用（500文字まで）、③では議論記録へ追記します。適用前にはすべて利用者の確認が必要です。処理中にrevisionや権限が変わった場合は適用を拒否します。長文は短い単位に区切ってください。

## 監査

SQLiteのauditには開始・成功／失敗、requestId、task、provider、model（未指定null）、時刻、利用者IDのハッシュを保存します。本文、音声、キーをログに出しません。提案は10分で失効します。送信する入力内容の認可をGateway側でも検証し、下流の処理ログをこのrequestIdで照合できるようにします。

実装テストでは注入したテスト専用transportを使います。これを本番のAI接続として使用する分岐はありません。

## mdファシリテータの構造化応答（v0.4）

`task: "questions"`で、`input.mode: "facilitation"`の場合は通常のquestions配列ではなく構造化JSONを返します。`input.systemInstructions`には管理者が保存したmd全体、`input.responseSchema`には期待するJSONスキーマを渡します。GatewayはsystemInstructionsを上位のモデル指示として適用し、カード本文や議論を利用者コンテンツとして扱ってください。

入力は現在のphase（ideation／selection／visualization／voting）、event、テーマ、カード（id／text／cluster_id）、選択カード、議論、直近の助言ID、UI状態、介入制限です。メールのメンバー一覧・個人別票・合計票を送信しません。

```json
{
  "should_speak": true,
  "message_id": "ideation-perspective-unique-id",
  "phase": "ideation",
  "message_type": "perspective_shift",
  "robot_animation": "insight",
  "bubble_text": "別の場面では、誰が同じ困りごとを感じていそうですか？",
  "duration_ms": 10000,
  "reason_code": "NEW_PERSPECTIVE",
  "suggested_clusters": []
}
```

話さない場合は`should_speak:false`。本文は120文字以内、duration_msは6000〜12000。状態・メッセージ種類等の許可値は`server/facilitator.js`のスキーマを参照します。分類の提案は`{name,nodeIds,reason}`の配列で最大8群。存在しないID・重複IDを拒否し、提案だけでは共有データを変更しません。

Gateway未設定の場合は外部送信せず、mdに定義した基本ガイドを明示表示します。承認済みGatewayが失敗した場合に基本ガイドへ応答を偽装して切り替えたり、別AIへ再送したりしません。
