# People, companies, and positions

The directory layer: who you know, where they work, and how to find and group them.

## People and companies

People and Companies each have a filterable list and a detail page. Detail pages carry the record's fields — including the agent-oriented ones like summary, relationship warmth, and ICP fit — plus tabs for everything attached: notes, activity, decisions, lists, and the records it links to. Editing is in place; changes save as you make them.

<!-- screenshot: person detail page -->

## Positions: who works where

A job title never sits on a person. It sits on a **Position**, the link between a person and a company — so "CEO at Acme" and "Advisor at Beta Labs" can both be true of the same person at once, and the title goes away with the position rather than lingering on the person after they move on. Linking a person to a company always goes through a position with a title.

This shows up in search too: searching for a title finds the people who hold it, even though the title is not a field on any person.

## Notes on a record

Notes attach to any record and support markdown. **Pin** the notes that matter: pinned notes float to the top, and they are what agents load first when a task is resolved for that record. More in [Planning and decisions](planning-and-decisions.md).

## Search

The header search box (and the `/search` page behind it) queries nine collections at once: handbook pages, people, roles, companies, deals, opportunities, raises, partnerships, and decisions. Results come back grouped, each group with its true total.

Matching is forgiving in one direction and strict in another: every word matches as a prefix (`acm` finds Acme, `meetings` finds "meeting"), and adding a second word narrows the result rather than widening it. Punctuation separates words, so pasting an email address finds the person by their address or by its domain alone.

<!-- screenshot: search results page -->

## Lists

A List is a hand-picked collection of records of one type: a conference shortlist of people, a key-accounts list of companies, a watchlist of deals. The type is chosen when the list is created and never changes — a person cannot be added to a company list, and Kelpie refuses the attempt with a clear message.

- A record can be on many lists, and its own **Lists** tab shows every membership.
- List names are unique in the workspace, so the sidebar never shows two lists with one label.
- Adding a record twice is refused; removing it from the list does not touch the record.
- Deleting a list removes only the list and its memberships, never the records on it.

Lists are curation, not search. Nothing joins or leaves a list except by someone (or some agent) putting it there or taking it off.

<!-- screenshot: list detail page -->

## Agents see the same records

Everything above — records, positions, notes, search, lists — is equally available to a connected agent, through the same operations the pages use. See [Connect an agent](../agents/connect-an-agent.md).
