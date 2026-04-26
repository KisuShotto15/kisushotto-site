import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main:          resolve(__dirname, 'index.html'),
        nutrition:     resolve(__dirname, 'nutrition/index.html'),
        tradeJournal:          resolve(__dirname, 'trade-journal/index.html'),
        tradeJournalTrades:    resolve(__dirname, 'trade-journal/trades.html'),
        tradeJournalAnalytics: resolve(__dirname, 'trade-journal/analytics.html'),
        tradeJournalInsights:  resolve(__dirname, 'trade-journal/insights.html'),
        habits:         resolve(__dirname, 'habits/index.html'),
        p2pMonitor:     resolve(__dirname, 'p2p-monitor/index.html'),
        bodyMetrics:    resolve(__dirname, 'body-metrics/index.html'),
      }
    }
  }
})
