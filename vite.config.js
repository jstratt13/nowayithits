import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// For GitHub Pages, build with VITE_BASE=/<repo-name>/.
// Locally `npm run dev` ignores this so the dev server stays at '/'.
const base = process.env.VITE_BASE || '/';

export default defineConfig({
  plugins: [react()],
  base,
});
