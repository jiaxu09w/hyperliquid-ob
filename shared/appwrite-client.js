const { Client, Databases, Query, ID } = require('node-appwrite');
const CONFIG = require('../config/config');

class AppwriteClient {
  constructor() {
    this.client = new Client()
      .setEndpoint(CONFIG.APPWRITE.ENDPOINT)
      .setProject(CONFIG.APPWRITE.PROJECT_ID)
      .setKey(CONFIG.APPWRITE.API_KEY);

    this.databases = new Databases(this.client);
    this.dbId = CONFIG.APPWRITE.DATABASE_ID;
    this.collections = CONFIG.APPWRITE.COLLECTIONS;
  }

  // ✅ 修复：测试连接方法
  async testConnection() {
    try {
      // 直接尝试列出一个集合的文档来测试连接
      const testCollectionId = this.collections.SYSTEM_STATE || 'system_state';
      
      const result = await this.databases.listDocuments(
        this.dbId,
        testCollectionId,
        [Query.limit(1)]
      );
      
      return {
        success: true,
        message: 'Connected successfully',
        collectionFound: true,
        documentCount: result.total
      };
      
    } catch (err) {
      // 404 意味着集合不存在，但连接是成功的
      if (err.code === 404) {
        return {
          success: true,
          message: 'Connected (collections not created yet)',
          collectionFound: false,
          hint: 'Run "npm run setup" to create collections'
        };
      }
      
      // 其他错误
      return {
        success: false,
        error: err.message,
        code: err.code,
        hint: err.code === 401 
          ? 'Invalid API Key. Check APPWRITE_API_KEY in .env'
          : err.code === 404
          ? 'Database not found. Check APPWRITE_DATABASE_ID in .env'
          : 'Check your Appwrite credentials'
      };
    }
  }

  // ✅ 辅助方法：安全执行
  async safeExecute(operation, errorMessage) {
    try {
      return await operation();
    } catch (err) {
      console.error(`${errorMessage}: ${err.message}`);
      
      if (err.code === 404) {
        throw new Error(`${errorMessage} - Resource not found. Run 'npm run setup' first.`);
      }
      
      throw new Error(`${errorMessage} - ${err.message}`);
    }
  }

  // Order Blocks
  async createOB(obData) {
    return await this.safeExecute(
      () => this.databases.createDocument(
        this.dbId,
        this.collections.ORDER_BLOCKS,
        ID.unique(),
        obData
      ),
      'Failed to create Order Block'
    );
  }

  async getUnprocessedOBs(symbol, limit = 5) {
    return await this.safeExecute(
      () => this.databases.listDocuments(
        this.dbId,
        this.collections.ORDER_BLOCKS,
        [
          Query.equal('symbol', symbol),
          Query.equal('isActive', true),
          Query.equal('isProcessed', false),
          Query.orderDesc('confirmationTime'),
          Query.limit(limit)
        ]
      ),
      'Failed to get unprocessed OBs'
    );
  }

  async updateOB(obId, data) {
    return await this.safeExecute(
      () => this.databases.updateDocument(
        this.dbId,
        this.collections.ORDER_BLOCKS,
        obId,
        data
      ),
      'Failed to update Order Block'
    );
  }

  async getActiveOBs(symbol, timeframe = null, limit = 100) {
    const queries = [
      Query.equal('symbol', symbol),
      Query.equal('isActive', true),
      Query.limit(limit)
    ];
    
    if (timeframe) {
      queries.push(Query.equal('timeframe', timeframe));
    }

    return await this.safeExecute(
      () => this.databases.listDocuments(
        this.dbId,
        this.collections.ORDER_BLOCKS,
        queries
      ),
      'Failed to get active OBs'
    );
  }

  // Positions
  async createPosition(posData) {
    return await this.safeExecute(
      () => this.databases.createDocument(
        this.dbId,
        this.collections.POSITIONS,
        ID.unique(),
        posData
      ),
      'Failed to create position'
    );
  }

  async getOpenPositions(symbol = null, limit = 10) {
    const queries = [
      Query.equal('status', 'OPEN'),
      Query.limit(limit)
    ];
    
    if (symbol) {
      queries.push(Query.equal('symbol', symbol));
    }

    return await this.safeExecute(
      () => this.databases.listDocuments(
        this.dbId,
        this.collections.POSITIONS,
        queries
      ),
      'Failed to get open positions'
    );
  }

  async updatePosition(posId, data) {
    return await this.safeExecute(
      () => this.databases.updateDocument(
        this.dbId,
        this.collections.POSITIONS,
        posId,
        data
      ),
      'Failed to update position'
    );
  }

  // Market Data
  async getMarketData(symbol, indicator, timeframe = null) {
    const queries = [
      Query.equal('symbol', symbol),
      Query.equal('indicator', indicator),
      Query.orderDesc('timestamp'),
      Query.limit(1)
    ];
    
    if (timeframe) {
      queries.push(Query.equal('timeframe', timeframe));
    }

    try {
      const result = await this.databases.listDocuments(
        this.dbId,
        this.collections.MARKET_DATA,
        queries
      );
      return result.documents.length > 0 ? result.documents[0] : null;
    } catch (err) {
      console.warn(`Could not get market data: ${err.message}`);
      return null;
    }
  }

  async saveMarketData(data) {
    return await this.safeExecute(
      () => this.databases.createDocument(
        this.dbId,
        this.collections.MARKET_DATA,
        ID.unique(),
        data
      ),
      'Failed to save market data'
    );
  }

  // System State
  async getSystemState(key) {
    try {
      const result = await this.databases.listDocuments(
        this.dbId,
        this.collections.SYSTEM_STATE,
        [
          Query.equal('key', key),
          Query.limit(1)
        ]
      );
      return result.documents.length > 0 ? result.documents[0].value : null;
    } catch (err) {
      console.warn(`Could not get system state: ${err.message}`);
      return null;
    }
  }

  async setSystemState(key, value) {
    try {
      const existing = await this.databases.listDocuments(
        this.dbId,
        this.collections.SYSTEM_STATE,
        [
          Query.equal('key', key),
          Query.limit(1)
        ]
      );

      if (existing.documents.length > 0) {
        return await this.databases.updateDocument(
          this.dbId,
          this.collections.SYSTEM_STATE,
          existing.documents[0].$id,
          { value, updatedAt: new Date().toISOString() }
        );
      } else {
        return await this.databases.createDocument(
          this.dbId,
          this.collections.SYSTEM_STATE,
          ID.unique(),
          { 
            key, 
            value, 
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        );
      }
    } catch (err) {
      throw new Error(`Could not set system state: ${err.message}`);
    }
  }

  // Logs
  async log(level, message, data = null) {
    try {
      return await this.databases.createDocument(
        this.dbId,
        this.collections.LOGS,
        ID.unique(),
        {
          level,
          message,
          data: data ? JSON.stringify(data) : null,
          timestamp: new Date().toISOString()
        }
      );
    } catch (err) {
      console.error(`Failed to write log: ${err.message}`);
      return null;
    }
  }
}

module.exports = AppwriteClient;