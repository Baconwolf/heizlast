# heizlast

Minimal TypeScript web project built with Vite.

## Commands

```sh
npm install
npm run dev
npm run build
npm run preview
```

The production build is written to `dist/`.

## GitHub Pages

Push the repository's `main` branch to GitHub. The workflow in `.github/workflows/deploy.yml` builds the site and deploys `dist/` to GitHub Pages.

In the repository settings, set **Pages > Build and deployment > Source** to **GitHub Actions**.