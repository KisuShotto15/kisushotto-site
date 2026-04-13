import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main:          resolve(__dirname, 'index.html'),
        nutrition:     resolve(__dirname, 'nutrition/index.html'),
        tradeJournal:  resolve(__dirname, 'trade-journal/index.html'),
        habits:        resolve(__dirname, 'habits/index.html'),
      }
    }
  }
})
