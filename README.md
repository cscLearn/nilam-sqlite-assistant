# NILAM SQLite Assistant

Independent Tampermonkey client for the SQLite-backed NILAM book service. It does not replace or update the existing JSON-based NILAM Assistant.

## Book sources

- **Real books (default):** traceable catalogue records with a source link. ISBN is validated when present and remains blank when the source has none.
- **AI-generated books:** clearly labelled simulations. They are never selected as an automatic fallback for the real-book pool.

Each source has separate server cursors and separate client state. Changing source explicitly reloads that pool.

## Install

After the repository is public, install:

https://raw.githubusercontent.com/cscLearn/nilam-sqlite-assistant/main/nilam-sqlite.user.js

Open AINS while logged in and make one normal manual NILAM submission so the script can capture the authorized request template. Use **Refresh Unused Books** to load the selected source.

## Verification

```powershell
node --check nilam-sqlite.user.js
node test-userscript.mjs
```

The automated checks do not submit records to AINS.

## Data note

“Real” means the catalogue metadata is traceable to its listed source. It does not imply that this repository distributes the book text or owns its copyright.
