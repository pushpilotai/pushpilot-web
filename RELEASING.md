# Releasing the web SDK

A version on npm can never be republished, even after unpublishing. Every step marked **Owner** needs the owner's explicit yes for that version.

## One-time setup (owner)

1. The npm organisation `pushpilotai` exists, with 2FA on the publishing account: `npm profile enable-2fa auth-and-writes`.
2. `npm login` on the release machine (`npm whoami` shows the account).

## Each release

1. Set the version in `package.json` (the build stamps it into the SDK) and the heading in `CHANGELOG.md` (replace "unreleased" with the date).
2. Checks pass:

   ```bash
   npm test && npm run typecheck
   npm pack --dry-run
   ```

   `npm pack` builds `dist/` first. Read the file list it prints: only `dist/` (`pushpilot.mjs`, `pushpilot.js`, `pushpilot-sw.js`, types), `README.md`, `LICENSE` and `package.json`.
3. Rehearse with `npm run example` against a local PushPilot server: subscribe, see the device in device lookup, receive a push with an image and buttons, click the body and a button, and see the clicks counted. Then the browser checks in README → *Before going live*.
4. Commit, merge to `main`, tag `<version>`. **Owner:** push `main` and the tag to `github.com/pushpilotai/pushpilot-web`.
5. **Owner:** `npm publish` (it asks for the 2FA code; `publishConfig.access` is already `public`).
6. Verify: a fresh page installs `@pushpilotai/web` from npm, hosts `node_modules/@pushpilotai/web/dist/pushpilot-sw.js` at its root, and the push check passes.
