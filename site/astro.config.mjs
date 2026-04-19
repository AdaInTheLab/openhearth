import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: 'https://openhearth.kitsuneden.net',
  integrations: [mdx()],
  trailingSlash: 'never',
});
