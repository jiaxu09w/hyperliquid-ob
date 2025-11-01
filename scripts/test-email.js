/**
 * 测试邮件发送
 */

const nodemailer = require('nodemailer');
require('dotenv').config();

async function testEmail() {
  console.log('📧 Testing email notification...\n');

  const config = {
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD
    }
  };

  if (!config.auth.user || !config.auth.pass) {
    console.error('❌ Email config missing in .env');
    console.log('\nRequired:');
    console.log('  EMAIL_USER=your-email@gmail.com');
    console.log('  EMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx');
    process.exit(1);
  }

  const transporter = nodemailer.createTransport(config);

  const testMessage = {
    from: `"OB Trading Bot (Test)" <${config.auth.user}>`,
    to: process.env.EMAIL_RECIPIENT || config.auth.user,
    subject: '🧪 测试邮件 - OB 交易系统',
    text: `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          🧪 邮件系统测试
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ 邮件系统配置正确！

发送时间: ${new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })}

如果你收到这封邮件，说明：
1. Gmail App Password 配置正确
2. nodemailer 工作正常
3. 可以接收交易通知

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `,
    html: `<pre style="font-family: 'Courier New', monospace;">
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          🧪 邮件系统测试
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ 邮件系统配置正确！

发送时间: ${new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })}

如果你收到这封邮件，说明：
1. Gmail App Password 配置正确
2. nodemailer 工作正常
3. 可以接收交易通知

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    </pre>`
  };

  try {
    const info = await transporter.sendMail(testMessage);
    console.log('✅ Email sent successfully!');
    console.log(`   Message ID: ${info.messageId}`);
    console.log(`   Recipient: ${process.env.EMAIL_RECIPIENT || config.auth.user}\n`);
  } catch (err) {
    console.error('❌ Email sending failed:', err.message);
    console.error('\nPossible issues:');
    console.error('  1. Gmail App Password incorrect');
    console.error('  2. Gmail "Less secure app access" blocked');
    console.error('  3. Network/firewall issues\n');
  }
}

testEmail();