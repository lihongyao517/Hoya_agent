# Code Signing Policy

## Free open-source code signing

Free code signing is provided by [SignPath.io](https://signpath.io/), with a
certificate provided by the [SignPath Foundation](https://signpath.org/).

Only release artifacts built from this public repository by the configured
GitHub Actions workflow are eligible for signing. Signing credentials are kept
in GitHub Actions secrets and SignPath; they are never stored in this
repository or distributed to maintainers.

## Roles

- Authors/committers: `lihongyao517`
- Reviewers: `lihongyao517`
- Approvers and release managers: `lihongyao517`
- SignPath submitter: the GitHub Actions trusted build integration

The project owner reviews changes, creates release tags, and approves release
signing requests. Every production release requires manual SignPath approval.

## Release process

1. A version tag matching `v<major>.<minor>.<patch>` starts the release build.
2. GitHub-hosted runners build the backend and Electron application.
3. SignPath signs the Hoya Agent application and backend executables.
4. Electron Builder creates NSIS, portable, and Squirrel.Windows packages from
   the signed app.
5. SignPath signs all three release executables.
6. The workflow rebuilds updater hashes and the blockmap from the signed NSIS
   installer, verifies Authenticode signatures, and publishes the release with
   the Squirrel `RELEASES` manifest and NuGet package required by the official
   Electron update service.

Unsigned artifacts must not be attached to an official GitHub Release.

## Reporting compromised releases

Report suspected malicious or compromised releases privately to
lihongyao517@gmail.com. Include the version, download URL, and SHA-256 hash when
available. Do not include API keys or confidential workspace data.
