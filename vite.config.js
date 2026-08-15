import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main:          resolve(__dirname, 'index.html'),
        nutrition:     resolve(__dirname, 'nutrition/index.html'),
        bodyMetrics:    resolve(__dirname, 'body-metrics/index.html'),
        planner:        resolve(__dirname, 'planner/index.html'),
      }
    }
  }
})
