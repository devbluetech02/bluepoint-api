import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: options.to,
      subject: options.subject,
      html: options.html,
    });
    return true;
  } catch (error) {
    console.error('Erro ao enviar email:', error);
    return false;
  }
}

export async function sendPasswordResetEmail(to: string, token: string, nome: string): Promise<boolean> {
  const resetUrl = `${process.env.BASE_URL}/redefinir-senha?token=${token}`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #2563eb; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
        .button { display: inline-block; background: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #6b7280; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>BluePoint</h1>
        </div>
        <div class="content">
          <h2>Olá, ${nome}!</h2>
          <p>Recebemos uma solicitação para redefinir a senha da sua conta no BluePoint.</p>
          <p>Clique no botão abaixo para criar uma nova senha:</p>
          <p style="text-align: center;">
            <a href="${resetUrl}" class="button">Redefinir Senha</a>
          </p>
          <p>Se você não solicitou a redefinição de senha, ignore este email.</p>
          <p>Este link expira em 1 hora.</p>
        </div>
        <div class="footer">
          <p>BluePoint - Sistema de Gestão de Ponto</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to,
    subject: 'Redefinição de Senha - BluePoint',
    html,
  });
}

export async function sendWelcomeEmail(to: string, nome: string, senhaTemporaria?: string): Promise<boolean> {
  const loginUrl = `${process.env.BASE_URL}/login`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #2563eb; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
        .button { display: inline-block; background: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        .credentials { background: #fff; border: 1px solid #e5e7eb; padding: 15px; border-radius: 6px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #6b7280; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>BluePoint</h1>
        </div>
        <div class="content">
          <h2>Bem-vindo(a), ${nome}!</h2>
          <p>Sua conta no BluePoint foi criada com sucesso.</p>
          ${senhaTemporaria ? `
          <div class="credentials">
            <strong>Suas credenciais de acesso:</strong><br>
            Email: ${to}<br>
            Senha temporária: ${senhaTemporaria}
          </div>
          <p>Recomendamos que você altere sua senha no primeiro acesso.</p>
          ` : ''}
          <p style="text-align: center;">
            <a href="${loginUrl}" class="button">Acessar Sistema</a>
          </p>
        </div>
        <div class="footer">
          <p>BluePoint - Sistema de Gestão de Ponto</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to,
    subject: 'Bem-vindo ao BluePoint!',
    html,
  });
}
