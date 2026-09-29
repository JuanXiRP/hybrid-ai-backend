# Exercise catalog

`exercises.json` is a vendored copy of [free-exercise-db](https://github.com/yuhonas/free-exercise-db)
(`dist/exercises.json`), 876 exercises.

- **Pinned commit:** `f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5`
- **Licence:** Unlicense (public domain)
- **Consumer:** `src/services/exerciseCatalogService.js`. Plan generation lists the catalog in the
  prompt, and the server resolves every strength exercise against it.

## Entry schema

| Field              | Notes                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `id`               | Stable identifier, e.g. `Barbell_Squat`. Unique. This is what the plan stores as `exerciseId`.  |
| `name`             | Canonical display name. Unique after normalisation.                                             |
| `force`            | `push`, `pull`, `static` or `null`.                                                             |
| `level`            | `beginner`, `intermediate` or `expert`.                                                         |
| `mechanic`         | `compound`, `isolation` or `null`.                                                              |
| `equipment`        | e.g. `barbell`, `dumbbell`, `body only`, or `null`.                                             |
| `primaryMuscles`   | Array of muscle names.                                                                          |
| `secondaryMuscles` | Array of muscle names.                                                                          |
| `instructions`     | Array of steps. Not used yet.                                                                   |
| `category`         | `strength`, `powerlifting`, `olympic weightlifting`, `plyometrics`, `strongman`, `stretching`, `cardio`. |
| `images`           | Relative image paths. Images are not vendored.                                                  |

## Refreshing

```bash
node scripts/sync-exercise-catalog.js <commit-sha>
```

The script validates the download before overwriting the file. Then update the pinned commit above.
Ids that disappear upstream would leave saved plans with an `exerciseId` that no longer resolves, so
review the diff before shipping a refresh.
