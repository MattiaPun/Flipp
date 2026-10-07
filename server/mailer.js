// Outgoing email via SMTP_URL (e.g. smtps://user:pass@smtp.example.com:465). Disabled when unset.
import nodemailer from 'nodemailer';

const url = process.env.SMTP_URL || '';
const from = process.env.MAIL_FROM || 'Flipp <no-reply@localhost>';
const transport = url ? nodemailer.createTransport(url) : null;

export const mailEnabled = () => !!transport;

export async function sendMail({ to, subject, text }) {
  if (!transport) throw Object.assign(new Error('Email is not configured on this instance'), { status: 503, expose: true });
  await transport.sendMail({ from, to, subject, text });
}
