import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main:          resolve(__dirname, 'index.html'),
        nutrition:     resolve(__dirname, 'nutrition/index.html'),     // redirige a Health
        bodyMetrics:    resolve(__dirname, 'body-metrics/index.html'), // redirige a Health
        planner:        resolve(__dirname, 'planner/index.html'),
        health:         resolve(__dirname, 'health/index.html'),
        healthRutina:   resolve(__dirname, 'health/rutina.html'),
        healthHoy:      resolve(__dirname, 'health/hoy.html'),
        healthNutricion: resolve(__dirname, 'health/nutricion/index.html'),
        healthMetricas:  resolve(__dirname, 'health/metricas/index.html'),
      }
    }
  }
})
