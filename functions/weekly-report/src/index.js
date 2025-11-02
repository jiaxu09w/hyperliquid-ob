/**
 * Weekly Report Generator v1.0
 * 
 * 功能：
 * ✅ 每周一自动生成交易报告
 * ✅ 统计上周所有交易
 * ✅ 计算胜率、盈亏比、总盈亏
 * ✅ 发送详细邮件报告
 * ✅ 提供策略建议
 * 
 * 运行时间：每周一 00:00 UTC（新西兰时间中午12点）
 * Cron: 0 0 * * 1
 */

const { Client, Databases } = require('node-appwrite');
const nodemailer = require('nodemailer');
const { getTradeStats } = require('./trade-logger');
const { COLLECTIONS } = require('./constants');

module.exports = async ({ req, res, log, error }) => {
  const startTime = Date.now();

  try {
    log('━'.repeat(70));
    log('📊 Weekly Report Generator v1.0');
    log('━'.repeat(70));

    // ═══════════════════════════════════════════════════════════════════════
    // 配置
    // ═══════════════════════════════════════════════════════════════════════

    const config = {
      endpoint: process.env.APPWRITE_ENDPOINT,
      projectId: process.env.APPWRITE_PROJECT_ID,
      apiKey: process.env.APPWRITE_API_KEY,
      databaseId: process.env.APPWRITE_DATABASE_ID,
      
      symbol: process.env.TRADING_SYMBOL || 'BTCUSDT',
      tradingEnabled: process.env.TRADING_ENABLED === 'true',
      
      emailEnabled: process.env.EMAIL_ENABLED === 'true',
      emailRecipient: process.env.EMAIL_RECIPIENT,
      emailConfig: {
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_APP_PASSWORD,
        },
      },
      
      // ✅ 报告设置
      maxTradesDisplay: parseInt(process.env.MAX_TRADES_DISPLAY) || 20,
      timezone: process.env.TIMEZONE || 'Pacific/Auckland'
    };

    if (!config.emailEnabled) {
      log('⚠️  Email disabled, skipping report');
      return res.json({ 
        success: true, 
        action: 'skipped', 
        reason: 'email_disabled' 
      });
    }

    if (!config.emailRecipient || !config.emailConfig.auth.user) {
      error('❌ Email config incomplete');
      return res.json({ 
        success: false, 
        error: 'Email config incomplete' 
      }, 400);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 初始化
    // ═══════════════════════════════════════════════════════════════════════

    const client = new Client()
      .setEndpoint(config.endpoint)
      .setProject(config.projectId)
      .setKey(config.apiKey);

    const databases = new Databases(client);

    // ═══════════════════════════════════════════════════════════════════════
    // 计算报告周期（上周一 00:00 - 上周日 23:59:59 UTC）
    // ═══════════════════════════════════════════════════════════════════════

    const now = new Date();
    const currentDay = now.getUTCDay(); // 0=Sunday, 1=Monday...
    
    // 计算上周一
    const lastMonday = new Date(now);
    const daysToLastMonday = currentDay === 0 ? 6 : currentDay + 6; // 如果今天是周日(0)，往回6天；否则往回 currentDay + 6
    lastMonday.setUTCDate(now.getUTCDate() - daysToLastMonday);
    lastMonday.setUTCHours(0, 0, 0, 0);

    // 计算上周日
    const lastSunday = new Date(lastMonday);
    lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);
    lastSunday.setUTCHours(23, 59, 59, 999);

    log(`\n📅 Report Period:`);
    log(`   From: ${lastMonday.toISOString()}`);
    log(`   To:   ${lastSunday.toISOString()}`);
    log(`   (${formatDate(lastMonday, config.timezone)} - ${formatDate(lastSunday, config.timezone)})`);

    // ═══════════════════════════════════════════════════════════════════════
    // 获取统计数据
    // ═══════════════════════════════════════════════════════════════════════

    log('\n📊 Gathering statistics...');

    const stats = await getTradeStats(
      databases, 
      config.databaseId, 
      lastMonday, 
      lastSunday,
      config.symbol
    );

    if (!stats) {
      error('❌ Failed to get trade stats');
      return res.json({ 
        success: false, 
        error: 'Failed to get stats' 
      }, 500);
    }

    log(`   Total trades: ${stats.totalTrades}`);
    log(`   Wins: ${stats.wins} | Losses: ${stats.losses}`);
    log(`   Total P&L: $${stats.totalPnL.toFixed(2)}`);
    log(`   Win rate: ${stats.winRate.toFixed(2)}%`);

    // ═══════════════════════════════════════════════════════════════════════
    // 生成并发送报告
    // ═══════════════════════════════════════════════════════════════════════

    log('\n📧 Sending weekly report email...');

    await sendWeeklyReport({
      config,
      stats,
      startDate: lastMonday,
      endDate: lastSunday,
      log
    });

    log('   ✅ Email sent successfully');

    const duration = Date.now() - startTime;

    log(`\n${'━'.repeat(70)}`);
    log(`✅ Weekly report completed in ${duration}ms`);
    log(`${'━'.repeat(70)}\n`);

    return res.json({
      success: true,
      period: {
        from: lastMonday.toISOString(),
        to: lastSunday.toISOString()
      },
      stats: {
        totalTrades: stats.totalTrades,
        wins: stats.wins,
        losses: stats.losses,
        totalPnL: stats.totalPnL,
        winRate: stats.winRate,
        profitFactor: stats.profitFactor
      },
      emailSent: true,
      duration,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    error(`\n❌ Weekly report error: ${err.message}`);
    error(err.stack);

    return res.json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════
// 辅助函数：格式化日期
// ═════════════════════════════════════════════════════════════════════════

function formatDate(date, timezone = 'Pacific/Auckland') {
  return date.toLocaleDateString('en-NZ', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function formatDateTime(date, timezone = 'Pacific/Auckland') {
  return date.toLocaleString('en-NZ', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

// ═════════════════════════════════════════════════════════════════════════
// 发送每周报告邮件
// ═════════════════════════════════════════════════════════════════════════

async function sendWeeklyReport({ config, stats, startDate, endDate, log }) {
  const transporter = nodemailer.createTransport(config.emailConfig);

  const isProfit = stats.totalPnL > 0;
  const emoji = isProfit ? '📈' : stats.totalPnL < 0 ? '📉' : '➖';

  const subject = `${emoji} 每周交易报告 | ${formatDate(startDate, config.timezone)} - ${formatDate(endDate, config.timezone)} | ${isProfit ? '盈利' : stats.totalPnL < 0 ? '亏损' : '持平'} $${Math.abs(stats.totalPnL).toFixed(2)}`;

  // ═══════════════════════════════════════════════════════════════════════
  // 生成交易列表
  // ═══════════════════════════════════════════════════════════════════════

  let tradeList = '';
  if (stats.trades.length > 0) {
    // 按时间倒序排列
    stats.trades.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    const tradesToShow = Math.min(stats.trades.length, config.maxTradesDisplay);
    
    for (let i = 0; i < tradesToShow; i++) {
      const trade = stats.trades[i];
      const tradeTime = formatDateTime(new Date(trade.timestamp), config.timezone);
      
      const tradeEmoji = trade.pnl > 0 ? '✅' : trade.pnl < 0 ? '❌' : '➖';
      const sideIcon = trade.side === 'LONG' ? '📈' : '📉';
      
      // 格式化：时间 | 方向 | 价格 | 盈亏
      tradeList += `${tradeEmoji} ${tradeTime} | ${sideIcon}${trade.side.padEnd(5)} | $${trade.price.toFixed(0).padStart(6)} | ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2).padStart(8)} (${trade.pnlPercent >= 0 ? '+' : ''}${trade.pnlPercent.toFixed(2)}%)\n`;
    }
    
    if (stats.trades.length > config.maxTradesDisplay) {
      tradeList += `\n... 还有 ${stats.trades.length - config.maxTradesDisplay} 笔交易（总计 ${stats.trades.length} 笔）\n`;
    }
  } else {
    tradeList = '   (本周无交易)\n';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 策略表现评估
  // ═══════════════════════════════════════════════════════════════════════

  let performanceEmoji, performanceText, recommendations;

  if (stats.totalTrades === 0) {
    performanceEmoji = 'ℹ️';
    performanceText = '本周无交易';
    recommendations = '• 检查 OB 检测是否正常\n• 确认交易条件是否过于严格';
  } else if (stats.winRate >= 50 && stats.profitFactor > 1.8 && stats.totalPnL > 0) {
    performanceEmoji = '🌟';
    performanceText = '策略表现优秀！';
    recommendations = '• 保持当前策略\n• 可考虑小幅增加仓位';
  } else if (stats.winRate >= 40 && stats.profitFactor > 1.3 && stats.totalPnL > 0) {
    performanceEmoji = '✅';
    performanceText = '策略表现良好';
    recommendations = '• 继续观察\n• 关注市场环境变化';
  } else if (stats.totalPnL > 0) {
    performanceEmoji = '⚠️';
    performanceText = '有盈利但需改进';
    recommendations = '';
    if (stats.winRate < 40) recommendations += '• 胜率偏低，提高入场质量\n';
    if (stats.profitFactor < 1.5) recommendations += '• 盈利因子偏低，优化止盈/止损比例\n';
    if (stats.avgLoss > stats.avgWin * 2) recommendations += '• 平均亏损过大，检查止损设置\n';
  } else {
    performanceEmoji = '❌';
    performanceText = '策略需要审查';
    recommendations = '';
    if (stats.wins === 0 && stats.totalTrades > 3) {
      recommendations += '• ⚠️  连续亏损，建议暂停交易并复盘\n';
    }
    if (stats.winRate < 30) recommendations += '• 胜率过低，重新评估 OB 检测逻辑\n';
    if (stats.profitFactor < 1) recommendations += '• 盈利因子<1，总体策略无效\n';
    if (stats.totalPnL < -500) recommendations += '• 亏损金额较大，降低风险或暂停\n';
    if (!recommendations) recommendations = '• 分析亏损原因\n• 考虑优化参数或暂停交易';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 邮件正文
  // ═══════════════════════════════════════════════════════════════════════

  const body = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
              📊 OB 自动交易系统 - 每周报告
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📅 报告周期: ${formatDate(startDate, config.timezone)} - ${formatDate(endDate, config.timezone)}
🕐 生成时间: ${formatDateTime(new Date(), config.timezone)} NZDT
🌐 环境: ${config.tradingEnabled ? '🔴 主网' : '🧪 测试网'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 盈亏总结
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

净盈亏:           ${isProfit ? '+' : ''}$${stats.totalPnL.toFixed(2)}
总手续费:         $${stats.totalFees.toFixed(2)}
毛盈亏:           ${isProfit ? '+' : ''}$${(stats.totalPnL + stats.totalFees).toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 交易统计
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

总交易次数:       ${stats.totalTrades}
盈利次数:         ${stats.wins} (${stats.totalTrades > 0 ? ((stats.wins / stats.totalTrades) * 100).toFixed(1) : 0}%)
亏损次数:         ${stats.losses} (${stats.totalTrades > 0 ? ((stats.losses / stats.totalTrades) * 100).toFixed(1) : 0}%)
盈亏平局:         ${stats.breakeven}

胜率:             ${stats.winRate.toFixed(2)}%
盈利因子:         ${stats.profitFactor > 0 ? stats.profitFactor.toFixed(2) : 'N/A'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 盈亏分析
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

平均盈利:         +$${stats.avgWin.toFixed(2)}
平均亏损:         -$${stats.avgLoss.toFixed(2)}
盈亏比:           ${stats.avgLoss > 0 ? (stats.avgWin / stats.avgLoss).toFixed(2) : 'N/A'}:1

最大单笔盈利:     +$${stats.largestWin.toFixed(2)}
最大单笔亏损:     ${stats.largestLoss.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 交易明细（最近 ${Math.min(stats.trades.length, config.maxTradesDisplay)} 笔）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${tradeList}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${performanceEmoji} 策略表现评估
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${performanceText}

${stats.totalTrades > 0 ? `📌 建议:
${recommendations}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 数据分析
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${stats.totalTrades > 0 ? `
做多交易:         ${stats.longTrades || 0} (${stats.longWins || 0} 胜 / ${stats.longLosses || 0} 负)
做空交易:         ${stats.shortTrades || 0} (${stats.shortWins || 0} 胜 / ${stats.shortLosses || 0} 负)

平均持仓时长:     ${stats.avgHoldingTime || 'N/A'}
最长持仓:         ${stats.maxHoldingTime || 'N/A'}

高置信度 OB:      ${stats.highConfidenceCount || 0} (${stats.highConfidenceWinRate || 0}% 胜率)
中置信度 OB:      ${stats.mediumConfidenceCount || 0} (${stats.mediumConfidenceWinRate || 0}% 胜率)
` : '暂无数据'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📱 查看详情
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Hyperliquid: https://app.hyperliquid${config.tradingEnabled ? '' : '-testnet'}.xyz/

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  这是自动生成的报告，请勿直接回复
💡 如需调整策略参数，请修改环境变量配置
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  // ═══════════════════════════════════════════════════════════════════════
  // 发送邮件
  // ═══════════════════════════════════════════════════════════════════════

  try {
    const info = await transporter.sendMail({
      from: `"OB Trading Bot Report" <${config.emailConfig.auth.user}>`,
      to: config.emailRecipient,
      subject: subject,
      text: body,
      html: `<pre style="font-family: 'Courier New', monospace; font-size: 11px; line-height: 1.5; background: #0d1117; color: #c9d1d9; padding: 24px; border-radius: 6px; border: 1px solid #30363d;">${body}</pre>`,
    });

    log(`   Message ID: ${info.messageId}`);
  } catch (err) {
    throw new Error(`Email sending failed: ${err.message}`);
  }
}