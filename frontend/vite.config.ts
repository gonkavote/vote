import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    // WalletConnect SDK and cosmjs-types reach for `Buffer`, `process` and
    // `global` at runtime — provide them in the browser bundle.
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'events'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
