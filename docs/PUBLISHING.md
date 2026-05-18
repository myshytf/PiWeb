# Publishing pi-web

Use this checklist when publishing the project to GitHub and npm.

## 1. Update package identity

If you do not own the `pi-web` npm name, change `package.json` to a scoped name such as `@your-npm-scope/pi-web` and update the GitHub URLs.

## 2. Verify locally

```bash
npm ci
npm run setup:frontend
npm run release:check
```

`release:check` builds the TypeScript backend, exports the frontend, and runs `npm pack --dry-run` so you can inspect the files that would be published.

## 3. Push to GitHub

```bash
git init -b main
git add .
git commit -m "Initial open-source release"
gh repo create myshytf/PiWeb --public --source=. --remote=origin --push
```

If you do not use the GitHub CLI, create an empty public repository on github.com and then run:

```bash
git remote add origin https://github.com/myshytf/PiWeb.git
git branch -M main
git push -u origin main
```

## 4. Create a GitHub release

```bash
git tag v0.2.0
git push origin v0.2.0
```

Then create a release from the tag in GitHub's Releases UI.

## 5. Publish to npm

```bash
npm login
npm publish --access public
```

After publishing, verify install:

```bash
npx pi-web --version
npx pi-web --help
```
