import { configuration } from '../server/index.js';
import { mailConfigured, mailTransport, mailFailure } from '../server/mail.js';

const config = configuration();
if (!mailConfigured(config.smtp)) {
  console.error(
    'メール設定が未完了です。送信元・SMTPユーザー・アプリパスワードを設定してください。',
  );
  process.exitCode = 1;
} else {
  const transport = mailTransport(config.smtp);
  try {
    await transport.verify();
    console.log('SMTP接続・認証を確認しました。メール送信と受信箱への到達はまだ確認していません。');
  } catch (error) {
    console.error(mailFailure(error, config.smtp));
    process.exitCode = 1;
  } finally {
    transport.close();
  }
}
