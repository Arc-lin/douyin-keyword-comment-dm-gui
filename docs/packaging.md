# Windows single-file packaging

Run:

```powershell
npm install
npm run build:exe
```

The output is `dist/DouyinKeywordCommentDM-v<version>.exe`, where `<version>`
matches the `version` field in `package.json` (bump it before building a new
release so each artifact is traceable). The target computer does not need
Node.js, but it must have Google Chrome or Microsoft Edge installed.

The executable embeds the application and Playwright. On first launch it
extracts the versioned runtime to:

```text
%LOCALAPPDATA%\DouyinKeywordCommentDM\runtime
```

Persistent settings, run results, and the browser login profile are stored in:

```text
%LOCALAPPDATA%\DouyinKeywordCommentDM\data
```

Existing development data under the repository's `data` directory is not
included in the executable. This avoids distributing login state, history, and
screenshots.
