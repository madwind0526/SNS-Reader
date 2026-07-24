# Rules

- UI text must be Korean.
- Source code comments must be English only.
- Credentials must not be stored as plaintext project files.
- `requiresLogin` is only a metadata flag for future secure login/session handling and must not collect or store raw passwords.
- SNS login passwords must not be stored in `.env`; use a user-driven login window, existing browser session references, access tokens, or OS keychain references.
