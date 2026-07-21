# Hoya Agent Privacy Policy

Last updated: July 21, 2026

Hoya Agent is a local workspace assistant. The project does not operate an
analytics or telemetry service and does not intentionally send usage data to
the project author.

## Data stored locally

Hoya Agent stores settings, model presets, API keys, project paths, task state,
conversation history, memory, and workspace indexes on the user's computer.
Model API keys are currently stored in the local settings file as plain text.
Users are responsible for protecting their Windows account and local files.

## Network connections

Hoya Agent makes network connections only when required by a user-selected
feature:

- Prompts, selected conversation context, and relevant workspace content may
  be sent to the model provider configured by the user. That provider's privacy
  policy and terms apply.
- The application contacts GitHub to check for and download updates.
- Links opened by the user are sent to the system's configured web browser.
- A locally configured model endpoint, such as Ollama, is contacted at the URL
  provided by the user.

The project author does not receive model requests, API keys, workspace files,
or conversation history unless the user deliberately sends that information.

## User control

Users choose the model provider and endpoint, can disable or avoid optional
network features, and can remove local Hoya Agent data from the application's
settings and workspace state directories. Before sharing diagnostics or issue
reports, users should remove API keys, tokens, personal data, and confidential
workspace content.

## Contact

Privacy questions can be sent to lihongyao517@gmail.com.
