# Import and export

Moving data in and out of Kelpie: CSV imports with vendor presets and a safe dry-run flow, CSV exports that round-trip, and the sample-data installer. All of it lives on **Admin → Data**.

Import and export need the admin role. A member gets a `403` on both.

## What you can import

People, companies, positions, and deals, as UTF-8 CSV. Four sources:

- **Custom CSV** — you map your file's headers to Kelpie's columns.
- **HubSpot**, **Salesforce**, and **Attio** — presets that already know those tools' export headers, including their deal-stage names.

Import in that order when migrating everything — companies, people, positions, deals — because later objects reference earlier ones.

## Every import is a dry run first

Uploading a file does not write anything. Kelpie parses it and plans every row — create, update, skip, or error — and shows the counts, the first failing rows, and a preview of how it read your columns. You review the plan, fix the mapping or the file if needed, then commit.

A corrected mapping is a fresh upload of the same file, so the stored record of a committed import always says exactly how it was read.

<!-- screenshot: import wizard mapping step -->

## Committing is safe to repeat

The commit re-checks every row against the workspace as it stands rather than replaying the plan, because rows earlier in the file create records later rows match against. That re-checking is also what makes committing idempotent: run it twice, or upload the same file again, and the second pass finds what the first one wrote instead of duplicating it. A row that fails takes only itself down; the rest of the file still commits.

A row that fails shows the reason. When the reason is a fault in the server, the row says "This row could not be saved because of a server error" and no more. The server log has the cause, with the job and the row number.

## Rules worth knowing

- **Blank cells write nothing.** An unmapped column, or a mapped column with an empty cell, is never written — so a partial export with an empty Summary column cannot erase every summary in your workspace. Clearing a field is an edit on the record, not an import.
- **Match keys decide updates.** Each import picks a key column (email for people, domain for companies, and so on) and whether a match is skipped or updated. Update overwrites only the mapped fields.
- **Deal stages resolve against your pipeline** — the stage's slug, then its label, then the HubSpot/Salesforce alias tables. A stage name that matches nothing fails the row rather than inventing a stage.
- **A deal with no matching company fails its row.** Kelpie does not create stub companies to hang deals on.
- **`owner_email` must name a workspace member.** Otherwise the row fails, rather than silently assigning the deal to whoever ran the import. Unmap the column to import without owners.
- **A column cannot be headed `__proto__`.** Kelpie refuses a file that has such a column. Rename the column and upload the file again.
- **A people file can carry a company and title.** The import then creates or renames the person's position at that company. If the company is not in the workspace yet, you choose: skip the link and import the person with a warning (the default), or create the company from the row.

## Large files

Over 500 rows, the dry run and the commit finish in the background and the job shows its progress. If a server restart strands a job mid-run, upload the file again — commits being idempotent makes that safe.

Limits: 10 MB per file, 10,000 rows per job, 500 columns per file.

## Record limits

A self-hosted Kelpie has no record limit, and nothing in this section applies to it. A hosted deployment can set one for each workspace. A record is a person or a company; deals, positions and the rest are not counted.

Where a limit applies, Kelpie checks it when you commit a People or a Companies import. If the dry run's **create** count is more than the room left, the commit is refused and writes no rows. The message gives both numbers. The job stays ready, so you can delete records or change plan and commit the same file again. An import that only updates records is never refused.

A company that a people file creates for a position is not in the dry run's count, so it is not in this check.

## Exporting

Each object exports as CSV with Kelpie's own headers, and there is a header-only template per object for building files by hand. A Kelpie export re-imports into any Kelpie with no mapping at all — stages export as slugs, money in major units — which makes export the workspace's portable backup for spreadsheets.

### Cells that look like formulas

A spreadsheet can run a cell as a formula when the cell starts with `=`, `+`, `-`, `@`, a tab or a carriage return. A record can hold such text. For example, a stranger can type it into a public form as a name.

An export writes one apostrophe (`'`) in front of such a cell, so the spreadsheet reads it as text. A record that holds `=SUM(A1)` is `'=SUM(A1)` in the file. A value that already starts with apostrophes and then one of those characters gets one more. A template follows the same rule.

A phone number and a negative number stay as they are. The rule leaves a cell alone when it starts with `+` or `-` and then has only digits, spaces, `.`, `(`, `)` and `-`. A cell with two phone numbers has the `|` separator, so it gets the apostrophe.

An import removes that one apostrophe again, so an export reads back as the values the records hold. The same applies to a file of your own: the cell `'=A1` imports as `=A1`. To import a value that starts with `'=`, write `''=`. The apostrophe must be the first character of the cell. A cell such as `'tis` or `O'Brien` does not change, and header cells do not change.

## Sample data

The same page carries the sample-data installer: one click fills an empty workspace with a working set of companies, people, deals, and the rest, for exploring the product. It refuses once the workspace holds real companies or people, so it can never double up or mix into live data.

<!-- screenshot: admin data page -->
