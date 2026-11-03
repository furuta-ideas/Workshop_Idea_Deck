import nodemailer from 'nodemailer';

export function mailConfigured(smtp = {}) {
  if (!smtp.host || !smtp.from) return false;
  if (String(smtp.host).toLowerCase() === 'smtp.gmail.com' && !smtp.user) return false;
  if (smtp.user && !smtp.password) return false;
  return true;
}

export function mailTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    requireTLS: !smtp.secure,
  });
}

export function mailFailure(error, smtp) {
  if (error.code === 'EAUTH') {
    return String(smtp.host).toLowerCase() === 'smtp.gmail.com'
      ? 'Gmailの認証が拒否されました。送信元メールとGoogleのアプリパスワードを確認してください。'
      : 'メール送信元の認証が拒否されました。SMTP認証設定を確認してください。';
  }
  if (['ECONNECTION', 'ETIMEDOUT', 'EDNS', 'ESOCKET'].includes(error.code))
    return 'メールサーバーへ接続できません。接続先・TLS・ネットワークを確認してください。';
  return 'メール配信に失敗しました。送信元の設定を確認してください。';
}
