import { defineConfig } from 'vite'
import { resolve } from 'path'

// Build aparte para trades.kisushotto.com. El trade journal ya no se emite en
// el sitio principal, asi que necesita su propia entrada y su propio outDir.
export default defineConfig({
  build: {
    outDir: 'dist-trade-journal',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        tradeJournal:          resolve(__dirname, 'trade-journal/index.html'),
        tradeJournalTrades:    resolve(__dirname, 'trade-journal/trades.html'),
        tradeJournalAnalytics: resolve(__dirname, 'trade-journal/analytics.html'),
        tradeJournalInsights:  resolve(__dirname, 'trade-journal/insights.html'),
      }
    }
  }
})
