# SignPath Foundation setup

Hoya Agent uses SignPath only for Windows code signing. GitHub Releases remains
the sole update and download server; Squirrel and `update.electronjs.org` are
not part of this release process.

## 1. Apply

Apply at <https://signpath.org/apply> with these project details:

- Project: Hoya Agent
- Repository: <https://github.com/lihongyao517/Hoya_agent>
- License: MIT
- Code signing policy: `CODE_SIGNING_POLICY.md`
- Privacy policy: `PRIVACY.md`
- Release page: <https://github.com/lihongyao517/Hoya_agent/releases>

## 2. Configure SignPath

After approval, install the SignPath GitHub App for this repository and use
GitHub Actions as the trusted build system. Create two artifact configurations:

- Application executables: `signpath/application.xml`
- NSIS and portable release executables: `signpath/release.xml`

Use a production signing policy with origin verification and manual approval.

## 3. Configure GitHub

Create this Actions secret:

- `SIGNPATH_API_TOKEN`

Create these Actions repository variables:

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`
- `SIGNPATH_APPLICATION_ARTIFACT_CONFIGURATION_SLUG`
- `SIGNPATH_RELEASE_ARTIFACT_CONFIGURATION_SLUG`

Never commit or send the API token in chat. After the certificate is assigned,
add its exact subject name to Electron Builder's Windows `publisherName`.

## 4. Release

1. Update the desktop version and push the release commit.
2. Push a matching semantic version tag.
3. Approve both SignPath requests created by the workflow.
4. Confirm the GitHub Release contains the signed setup EXE, portable EXE,
   setup blockmap, and `latest.yml`.
5. Confirm both EXE signatures show `Valid` with `Get-AuthenticodeSignature`.

The workflow rebuilds updater metadata after the installer is signed so
Electron Updater validates the final signed bytes stored on GitHub Releases.
