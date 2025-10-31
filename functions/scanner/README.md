# Scanner Function

扫描 Order Block 并保存到数据库

## 配置

- **Root Directory**: `functions/scanner`
- **Entrypoint**: `src/index.js`
- **Runtime**: Node.js 18.0
- **Schedule**: `*/5 * * * *` (每 5 分钟)

## 环境变量

需要设置以下环境变量（在 Function Settings 中）：