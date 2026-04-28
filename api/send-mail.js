// Vercel Serverless Function — Naver SMTP 메일 발송
// URL: POST /api/send-mail
// Body: { to, subject, message, fileName, fileBase64, fromName? }
//
// 🔧 Vercel 환경변수 설정 (한 번만):
//  Vercel Dashboard → 프로젝트 → Settings → Environment Variables
//   • NAVER_SMTP_USER  = gplan23@naver.com
//   • NAVER_SMTP_PASS  = (네이버 메일 → 환경설정 → POP3/SMTP 설정 → 발급된 비밀번호)
//  저장 후 Vercel이 자동 재배포되어야 적용됨.

import nodemailer from 'nodemailer';

export const config = {
  api: {
    // 첨부파일 base64 포함을 위해 본문 크기 제한 상향 (Naver SMTP는 보통 25MB까지)
    bodyParser: { sizeLimit: '20mb' },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const SMTP_USER = process.env.NAVER_SMTP_USER;
  const SMTP_PASS = process.env.NAVER_SMTP_PASS;
  if (!SMTP_USER || !SMTP_PASS) {
    res.status(500).json({
      error: 'Naver SMTP 환경변수 미설정',
      hint: 'Vercel Dashboard → Settings → Environment Variables 에 NAVER_SMTP_USER, NAVER_SMTP_PASS 등록 후 재배포해주세요.',
    });
    return;
  }

  const { to, subject, message, fileName, fileBase64, fromName } = req.body || {};
  if (!to || !subject || !fileName || !fileBase64) {
    res.status(400).json({ error: '필수 필드 누락', required: ['to', 'subject', 'fileName', 'fileBase64'] });
    return;
  }

  // Naver SMTP — 465 + SSL (가장 호환성 좋음)
  const transporter = nodemailer.createTransport({
    host: 'smtp.naver.com',
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  try {
    const info = await transporter.sendMail({
      from: `"${fromName || '지플랜'}" <${SMTP_USER}>`,
      to,
      subject,
      text: message || '',
      attachments: [{
        filename: fileName,
        content: Buffer.from(fileBase64, 'base64'),
      }],
    });
    res.status(200).json({ ok: true, messageId: info.messageId, accepted: info.accepted });
  } catch (err) {
    console.error('[send-mail] 실패:', err);
    res.status(500).json({
      error: err.message || String(err),
      code: err.code,
      response: err.response,
    });
  }
}
