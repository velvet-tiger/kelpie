/**
 * The most a request field may carry.
 *
 * The request body limit (`bodyLimit.ts`) is the outer bound. These are the
 * inner ones: without them one field could be the whole megabyte, and it would
 * then be stored, indexed for search, copied to activities and sent to
 * webhooks. The values are well above what a person or an agent writes, so a
 * request that meets one is a mistake or an attack, not a long note.
 *
 * They apply to what a request sends. A value already stored is not checked
 * again, and a response schema has no maximum.
 */

/** An id, or a key that works like one. Ids are a short prefix and a ULID. */
export const MAX_ID_LENGTH = 200

/**
 * One line: a name, a title, a label, a kind, a tag-like value.
 *
 * An email address uses this too. Whether it is a real mailbox is the
 * service's question, with its own answers: a password reset request for an
 * address too long to exist is skipped without a word, not refused.
 */
export const MAX_SHORT_TEXT_LENGTH = 500

/** Paragraphs: a summary, a description, a rationale. */
export const MAX_LONG_TEXT_LENGTH = 50_000

/** A document: a note or a handbook page. */
export const MAX_DOCUMENT_LENGTH = 500_000

/** Far above any passphrase, and it bounds what the password hash is asked to read. */
export const MAX_PASSWORD_LENGTH = 1024

/** An emailed token, or a credential a caller stores with us. */
export const MAX_TOKEN_LENGTH = 512
export const MAX_AUTH_HEADER_LENGTH = 8192

export const MAX_URL_LENGTH = 2048

/** One tag, and how many a record may have. Matches a custom field's multi-select. */
export const MAX_TAG_LENGTH = 120
export const MAX_TAGS = 100

/** Ids or small objects listed on one record: linked people, fields of a form, consents. */
export const MAX_LIST_ITEMS = 200
