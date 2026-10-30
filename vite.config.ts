import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      '/api/nominatim': {
        target: 'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/api\/nominatim/, ''),
        headers: {
          'User-Agent':
            'WhereHo/1.0 (safety route planning application)',
        },
      },
    },
  },
})