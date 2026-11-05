# Desktop translations

English source strings live in `en.json`. Translations are maintained in the `desktop` resource of the NitroBolt Transifex project and are downloaded into `generated-translations.json`.

The download website uses the `desktop-website` resource. Its English source and generated translations live in `docs/l10n`.

The `Sync translations` workflow runs weekly and can also be started manually. It uploads the current English strings, downloads reviewed translations, and commits changes to the generated file.

The workflow requires these repository or organization secrets:

- `TRANSIFEX`: Transifex API token with access to the NitroBolt project.
- `AUTOMATION`: GitHub token used to commit generated translation updates.

For local use, set `TRANSIFEX_TOKEN`, then run:

```sh
pnpm run translations:upload
pnpm run translations:download
```

Do not edit `generated-translations.json` manually.
