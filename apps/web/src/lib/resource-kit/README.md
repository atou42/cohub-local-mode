# Resource kit

Task, Checkpoint, Schedule and App helpers and views shared by Web and the
first-party resource Apps in `cohub-apps/`, which import this directory through
their `$kit` alias.

- Import only relative files, `$messages` and packages; `$lib`, `$app` and
  `$env` are lint errors here because the Apps have no SvelteKit runtime.
- Take `locale` explicitly instead of reading the Web locale store.
- Style with the Web semantic Tailwind classes; the Apps map them to host
  appearance tokens.
