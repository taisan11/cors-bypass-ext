import { defineConfig } from 'vite'
import { webext } from '@taisan11/vite-plugin-webext'

export default defineConfig({
  plugins: [
    webext({
      defaultBrowser: 'chrome',
      manifest: {
        manifest_version: 3,
        name: 'CORS Bypass Extension',
        version: '0.0.1',
        background: { service_worker: 'src/background.ts', type: 'module' },
        action: { default_popup: 'src/popup/index.html', default_title: 'CORS Bypass' },
        content_scripts: [
          { matches: ['*://*/*'], js: ['src/content.ts'], run_at: 'document_start', all_frames: true },
          {
            matches: ['*://*/*'],
            js: ['src/main.ts'],
            run_at: 'document_start',
            all_frames: true,
            world: 'MAIN',
          },
        ],
        host_permissions: ['*://*/*'],
        permissions: ['storage', 'declarativeNetRequest'],
      },
    }),
  ],
})
