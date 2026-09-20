export const escapeHiveEnvelopeText = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export const escapeHiveEnvelopeAttribute = (value: string): string =>
  escapeHiveEnvelopeText(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;')
