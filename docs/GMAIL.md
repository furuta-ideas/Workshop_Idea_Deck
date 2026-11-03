# GmailをOTPの送信元に設定する

現在のSMTP方式ではGoogleのアプリパスワードを使用します。通常のGoogleアカウントのパスワードは使用しません。アプリパスワードの発行には2段階認証が必要です。Googleは対応アプリでは「Googleでログイン」を案内していますが、本アプリのSMTP接続にはそのOAuth設定がまだありません。

[Google公式：アプリパスワード](https://support.google.com/accounts/answer/185833?hl=ja)、[Gmail送信設定](https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app?hl=ja)

## ローカル設定

`.env.example` を `.env` にコピーし、以下を設定します。自分のメールアドレスとアプリパスワードは公開リポジトリへ入れません。

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=自分のGmailアドレス
SMTP_FROM=自分のGmailアドレス
SMTP_PASSWORD=
BOOTSTRAP_ADMIN_EMAIL=初期管理者として使う登録メール
```

## 利用者が行う操作

1. 送信元のGoogleアカウントで、2段階認証が有効か確認する。
2. [Googleのアプリパスワード画面](https://myaccount.google.com/apppasswords)を開き、用途名を「ワークショップOTP」などとして発行する。アカウント認証と発行操作は利用者が行う。
3. リポジトリ内のPowerShellで次を実行し、発行された16文字を入力する。入力値は画面にもチャットにも出さない。

```powershell
& .\scripts\set-gmail-password.ps1
```

または、ローカルの `.env` の `SMTP_PASSWORD=` の右側に、発行された16文字を空白なしで直接入力して保存します。アプリパスワードが表示されない場合はGoogle公式ヘルプで、アカウント種類・高度な保護・2段階認証方式の条件を確認してください。保護設定を弱めて回避する操作は行いません。

## 接続確認と起動

```sh
node --env-file=.env scripts/check-mail.js
node --env-file=.env server/index.js
```

前者はSMTP接続と認証だけを検証し、メールは送信しません。成功しても受信到達の証明ではありません。後者が通常モードです。体験モードの `server/demo.js` は、SMTPが設定されてもOTPを送信しません。同じポートの体験サーバーを停止してから通常サーバーへ切り替えます。

通常モードには初期管理者またはNotionから同期された参加者の登録が必要です。受信先を入力するだけで自動登録することはありません。初期管理者がログインできたら、2つ目の受信先を適切な権限で登録するか、長期Notion接続を設定して参加者を同期します。

実際の受入確認は、各登録済み受信先へのOTP送信、受信、コードによるログインまで行います。SMTPエラーを成功扱いしたり、代わりの固定コードを発行する動作はありません。
