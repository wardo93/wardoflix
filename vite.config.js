import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the built index.html works under file://
  // (Electron loads dist/index.html directly). Default '/' would resolve
  // to the drive root and 404 everything.
  base: './',
  plugins: [react()],
  build: {
    // Video.js is ~500KB gzipped — splitting it into its own chunk lets
    // the React/UI shell paint first, then the player arrives in parallel.
    // React gets its own vendor chunk so it's cached separately across
    // deploys that only touch our app code.
    rollupOptions: {
      output: {
        manualChunks: {
          videojs: ['video.js'],
          react: ['react', 'react-dom'],
        },
      },
    },
    // Raise the warn threshold — video.js legitimately lands above 500KB
    // and we've already quarantined it in its own chunk above.
    chunkSizeWarningLimit: 900,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/stream': 'http://localhost:3000',
      '/remux': 'http://localhost:3000',
      '/trailer': 'http://localhost:3000',
    },
  },
})
