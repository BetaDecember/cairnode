# Workbench

A deliberately small project used by the recode hand-run evals. It has passing tests, one
failing test, a runtime error in a script, and a few markers to find.

```sh
npm test        # one failure, in the slugify punctuation test
npm run report  # crashes on an undefined stats function
node src/index.js
```
