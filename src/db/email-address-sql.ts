/**
 * SQL fragments for read-only matching against stored email address strings.
 *
 * Stored From values can be either bare addresses (`ops@example.com`) or display
 * name forms (`Ops <ops@example.com>`). Authorization still uses the strict
 * TypeScript parser; these helpers are intentionally tolerant for historical
 * rows and reporting queries.
 */
export function sqlEmailAddress(value: string): string {
  const normalized = `LOWER(TRIM(${value}))`;
  return `CASE
    WHEN instr(${normalized}, '<') > 0 AND instr(${normalized}, '>') > instr(${normalized}, '<')
      THEN TRIM(substr(${normalized}, instr(${normalized}, '<') + 1, instr(${normalized}, '>') - instr(${normalized}, '<') - 1))
    ELSE rtrim(${normalized}, ' >')
  END`;
}

export function sqlEmailDomain(value: string): string {
  const address = sqlEmailAddress(value);
  return `CASE
    WHEN instr(${address}, '@') = 0 THEN NULL
    ELSE substr(${address}, instr(${address}, '@') + 1)
  END`;
}
