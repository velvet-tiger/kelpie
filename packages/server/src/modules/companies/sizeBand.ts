import type { CompanyStage, SizeBand } from '@kelpie/schemas'

/**
 * The size band a company takes when the caller names none.
 *
 * An enterprise is a large organisation, so it does not take the smallest band.
 * Every other stage keeps `1-10`: the honest reading of a company nobody has
 * sized yet. The column is `NOT NULL`, so a band is always written.
 */
export function defaultSizeBandFor(stage: CompanyStage): SizeBand {
  return stage === 'enterprise' ? '201+' : '1-10'
}
