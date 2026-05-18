# Publishing PiWeb

Use this checklist when publishing the project to GitHub and npm.

## 1. Package identity

The unscoped `pi-web` npm package name is already taken by another maintainer, so this project uses the scoped package name:

```text
@minyongchoi94/pi-web
```

The CLI binary installed by the package is still named `pi-web`.

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
git remote add origin https://github.com/myshytf/PiWeb.git
git push -u origin main
```

Or with the GitHub CLI:

```bash
gh repo create myshytf/PiWeb --public --source=. --remote=origin --push
```

## 4. Create a GitHub release

```bash
git tag v0.3.0
git push origin v0.3.0
```

Then create a release from the tag in GitHub's Releases UI.

## 5. Publish to npm

```bash
npm whoami
npm publish --access public
```

If npm returns a 2FA/OTP error, use the current one-time password from your npm authenticator app:

```bash
npm publish --access public --otp=123456
```

If you publish through CI instead, create a granular npm access token with publish permissions for `@minyongchoi94/pi-web` and enable npm's 2FA bypass option for that token.

After publishing, verify install:

```bash
npx @minyongchoi94/pi-web --version
npx @minyongchoi94/pi-web --help
```
