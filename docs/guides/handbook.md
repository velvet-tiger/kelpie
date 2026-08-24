# Handbook

A nested markdown wiki inside your CRM: product, voice, ideal customer profile, how you sell, case studies. It is the narrative half of the company brain — the CRM records say who you know; the handbook says who you are.

## Why a handbook lives in your CRM

Agents. When an agent task runs — draft outreach, score a company against your ICP, prepare a meeting brief — Kelpie resolves the relevant handbook pages into the prompt alongside the CRM data. An agent drafting in "your voice" is reading your Voice and tone page, not guessing. The better the handbook, the better every agent's output, with no prompt engineering on your side.

Every new workspace starts with a seeded set of starter pages (About us, Product, Ideal customer profile, Voice and tone, Pricing, How we sell, and others) as stubs to fill in.

## Writing pages

Pages are markdown, edited in place: headings, lists, tables, links, bold, inline code. Case studies, launch notes, and anything narrative belong here rather than in a separate wiki.

<!-- screenshot: handbook page editor -->

## Organising the tree

Pages nest up to five levels. In the sidebar, one drag gesture does everything: drag a page up or down to reorder it, sideways to indent it under a neighbour or lift it out a level. Kelpie refuses moves that would break the tree — nesting a page under itself or one of its own subpages, or pushing a page's subtree past the depth limit — with a clear message rather than a mangled tree.

Deleting a page deletes every page under it. Kelpie tells you so before you do it.

<!-- screenshot: handbook tree drag -->

## Slugs are stable handles

Every page has a slug — a short, stable identifier. Renaming a page's title never changes its slug, so anything that references the page by slug (agent tasks name their required handbook pages this way) keeps working through renames. Changing a slug is a separate, deliberate edit, and a slug already in use is refused.

## Search covers it

Handbook pages are part of workspace search, body text included, so "what did we write about pricing?" is a search away for your team and one tool call away for an agent.
