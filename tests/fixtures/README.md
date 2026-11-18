# Test fixtures

`db-da1ecc2.db` is a database exactly as the app wrote it at commit `da1ecc2`, the last
commit before numbered migrations (its `user_version` is 0). It holds only the fictional
sample family, plus one extra ledger row labelled "Fixture marker", so the upgrade test
can check that existing data survives.

It was made by running that commit's `getDb()` on an empty file, inserting the marker row,
checkpointing the WAL and switching the file to `journal_mode = DELETE`, so it is a
single self-contained file. Never regenerate it with newer code. A fixture for a later
schema gets its own file, named after its commit.
