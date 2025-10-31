#!/bin/bash

echo "🚀 Deploying Hyperliquid OB Trader to Appwrite..."
echo ""

# 检查 Appwrite CLI
if ! command -v appwrite &> /dev/null
then
    echo "❌ Appwrite CLI not found. Installing..."
    npm install -g appwrite
fi

# 登录 Appwrite (如果需要)
echo "1️⃣  Checking Appwrite login..."
appwrite client --endpoint $APPWRITE_ENDPOINT --project $APPWRITE_PROJECT_ID --key $APPWRITE_API_KEY

# 部署 Functions
echo ""
echo "2️⃣  Deploying Functions..."

# Scanner
echo "   Deploying Scanner..."
cd functions/scanner
npm install
appwrite deploy function --functionId scanner
cd ../..

# Entry Monitor
echo "   Deploying Entry Monitor..."
cd functions/entry-monitor
npm install
appwrite deploy function --functionId entry-monitor
cd ../..

# Position Monitor
echo "   Deploying Position Monitor..."
cd functions/position-monitor
npm install
appwrite deploy function --functionId position-monitor
cd ../..

# ATR Calculator
echo "   Deploying ATR Calculator..."
cd functions/atr-calculator
npm install
appwrite deploy function --functionId atr-calculator
cd ../..

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Next steps:"
echo "1. Verify functions in Appwrite Console"
echo "2. Check function logs"
echo "3. Monitor first execution"